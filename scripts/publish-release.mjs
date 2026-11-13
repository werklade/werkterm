// Publishes a release built by CI (artifact "werkterm-<v>", see scripts/release-bundle.mjs)
// from the publishing machine to pkg.werklade.de over SSH (forced command werklade-publish,
// ../packages docs/publish-protokoll.md).
// Usage:
//   npm run publish-pkg -- <version> --channel test|stable [--from <dir>] [--run <run-id>]
//                          [--host <ssh alias>] [--dry-run]
// The SSH alias (default "werklade-pkg") comes from the user's ~/.ssh/config; host, user and
// key never live in this repository. ssh asks for a passphrase itself or uses the ssh-agent.
// Channel "test" uploads only the release tar to updates-test; channel "stable" uploads the
// .deb to APT and the release tar to updates (after saving the current latest.json to a fixed
// backup folder, see backupDir). Every abort states what has already changed on the server.
// Node >= 22, no dependencies. Exit codes: 0 ok, 1 check failed, 2 usage error, otherwise the
// exit code of gh or of the server (ssh).
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BASE_URL,
  LATEST,
  PRODUCT,
  SUMS,
  artifactNames,
  compareVersions,
  inspectTar,
  isValidVersion,
  serverFileNames,
  sha256File,
  validateServerRelease,
  validateSha256Sums,
  validateTarEntries,
} from "./release-bundle.mjs";

export const DEFAULT_HOST = "werklade-pkg";
export const LATEST_URL = `${BASE_URL}/${PRODUCT}/updates/latest.json`;
/** Server limit of version folders per product under downloads/. */
export const MAX_VERSIONS = 40;
const HOST_RE = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,254}$/;
const RUN_RE = /^[1-9][0-9]{0,19}$/;

export const USAGE =
  "Aufruf: npm run publish-pkg -- <version> --channel test|stable [--from <ordner>] [--run <run-id>] [--host <ssh-alias>] [--dry-run]";

export class UsageError extends Error {}

/** Parses the command line (without node and script path); throws UsageError. */
export function parsePublishArgs(argv) {
  const options = { host: DEFAULT_HOST, dryRun: false };
  const positional = [];
  const valued = new Set(["--channel", "--from", "--run", "--host"]);
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg === "--dry-run" && value === undefined) options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (valued.has(arg)) {
      if (value === undefined) {
        if (i + 1 >= argv.length) throw new UsageError(`${arg} braucht einen Wert`);
        value = argv[++i];
      }
      options[arg.slice(2)] = value;
    } else if (arg.startsWith("-")) throw new UsageError(`Unbekannte Option: ${arg}`);
    else positional.push(arg);
  }
  if (options.help) return options;
  if (positional.length !== 1) throw new UsageError("Genau eine Version angeben");
  options.version = positional[0];
  if (!isValidVersion(options.version)) throw new UsageError(`Version ungültig (MAJOR.MINOR.PATCH ohne führende Nullen): ${options.version}`);
  if (options.channel !== "test" && options.channel !== "stable") throw new UsageError("--channel test oder --channel stable angeben");
  if (!HOST_RE.test(options.host)) throw new UsageError(`SSH-Alias ungültig: ${options.host}`);
  if (options.from !== undefined && options.run !== undefined) throw new UsageError("--from und --run nicht zusammen angeben");
  if (options.from === undefined && options.run === undefined) throw new UsageError("--run <run-id> angeben (oder --from <ordner>)");
  if (options.run !== undefined && !RUN_RE.test(options.run)) throw new UsageError(`Run-ID ungültig: ${options.run}`);
  if (options.from !== undefined && !options.from) throw new UsageError("--from braucht einen Ordner");
  return options;
}

/** Remote command for werklade-publish, built only from fixed words and a validated version. */
export function remoteCommand(kind, version) {
  if (kind === "status") return `status ${PRODUCT}`;
  if (!["deb", "release", "release-test"].includes(kind)) throw new Error(`Unbekannter Befehl: ${kind}`);
  if (!isValidVersion(version)) throw new Error(`Version ungültig: ${version}`);
  return `${kind} ${PRODUCT} ${version}`;
}

export function releaseKind(channel) {
  return channel === "stable" ? "release" : "release-test";
}

/** ssh argument array; "--" ends option parsing so the alias can never act as an option. */
export function sshArgs(host, command) {
  if (!HOST_RE.test(host)) throw new Error(`SSH-Alias ungültig: ${host}`);
  return ["--", host, command];
}

export function ghDownloadArgs(run, version, dir) {
  if (!RUN_RE.test(run)) throw new Error(`Run-ID ungültig: ${run}`);
  if (!isValidVersion(version)) throw new Error(`Version ungültig: ${version}`);
  return ["run", "download", run, "-n", `${PRODUCT}-${version}`, "-D", dir];
}

/** Shell-like display of a command for output and --dry-run. */
export function displayCommand(program, args, inputPath) {
  const quote = arg => (/^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : `"${arg}"`);
  return [program, ...args.map(quote)].join(" ") + (inputPath ? ` < ${quote(inputPath)}` : "");
}

/** Download cache for CI artifacts (temporary, may be removed any time). */
export function cacheDir(version, base = tmpdir()) {
  return join(base, "werkterm-publish", version);
}

/** Fixed folder for latest.json backups (not temp): %LOCALAPPDATA% on Windows, XDG state dir elsewhere. */
export function backupDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const base =
    platform === "win32" ? env.LOCALAPPDATA || join(home, "AppData", "Local") : env.XDG_STATE_HOME || join(home, ".local", "state");
  return join(base, "werkterm-publish", "backups");
}

/** Backup name as in ../packages docs/betrieb.md 7.1; the version must be valid. */
export function backupFileName(version) {
  if (!isValidVersion(version)) throw new Error(`Version der latest.json ungültig: ${version}`);
  return `werkterm-updates-${version}.json`;
}

export function timestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

const versionOrNull = value => value === null || (typeof value === "string" && value.length > 0);
const stringList = value => Array.isArray(value) && value.every(item => typeof item === "string");

/** Parses the one-line JSON of "status werkterm"; throws on unexpected content. */
export function parseStatus(text) {
  let status;
  try {
    status = JSON.parse(text);
  } catch {
    throw new Error("Status des Servers ist kein JSON");
  }
  if (
    typeof status !== "object" || status === null || status.product !== PRODUCT ||
    !versionOrNull(status.release) || !versionOrNull(status.release_test) ||
    !stringList(status.downloads) || !stringList(status.apt) || !stringList(status.withdrawn ?? [])
  ) {
    throw new Error("Status des Servers hat ein unerwartetes Format");
  }
  return { ...status, withdrawn: status.withdrawn ?? [] };
}

export function formatStatus(status) {
  const list = items => (items.length ? items.join(", ") : "-");
  return [
    `  stable (updates):       ${status.release ?? "-"}`,
    `  test (updates-test):    ${status.release_test ?? "-"}`,
    `  APT:                    ${list(status.apt)}`,
    `  Downloads:              ${list(status.downloads)}`,
    `  Zurückgenommen:         ${list(status.withdrawn)}`,
  ].join("\n");
}

/**
 * Pre-flight check against the server status. Returns { error } to stop, or { notes, compareDownloads }.
 * Stable refuses a lower version than the published one (the server would too). compareDownloads
 * is true when downloads/<v>/ already exists and must match the local release byte for byte.
 */
export function preflight({ channel, version, status }) {
  const notes = [];
  if (status.withdrawn.includes(version)) return { error: `Version ${version} ist auf dem Server zurückgenommen (withdrawn)` };
  const published = status.downloads.includes(version);
  if (!published && status.downloads.length >= MAX_VERSIONS) {
    return {
      error: `Auf dem Server liegen bereits ${status.downloads.length} Versionsordner (höchstens ${MAX_VERSIONS}); alte Versionen aufräumen (../packages docs/betrieb.md, Abschnitt 4)`,
    };
  }
  if (channel === "stable") {
    if (status.release !== null && isValidVersion(status.release)) {
      const order = compareVersions(status.release, version);
      if (order > 0) return { error: `Downgrade: stable steht auf ${status.release}, ${version} ist älter` };
      if (order === 0) notes.push(`stable steht bereits auf ${version}; Lauf ist eine Wiederholung`);
    }
    const newerDeb = status.apt.filter(v => isValidVersion(v) && compareVersions(v, version) > 0);
    if (newerDeb.length) return { error: `APT enthält bereits die höhere Version ${newerDeb.join(", ")}` };
  }
  return { notes, compareDownloads: published };
}

export function publishedSumsUrl(version) {
  if (!isValidVersion(version)) throw new Error(`Version ungültig: ${version}`);
  return `${BASE_URL}/${PRODUCT}/downloads/${version}/${SUMS}`;
}

/**
 * For a version that already has downloads/<v>/ on the server: compares the published SHA256SUMS
 * byte for byte with the local one (localSums: Buffer). Returns { error } or {}.
 */
export async function comparePublishedSums({ version, localSums, fetchImpl = fetch }) {
  const url = publishedSumsUrl(version);
  let response;
  try {
    response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
  } catch (error) {
    return { error: `${url} nicht abrufbar (${error.message}); Inhalt der veröffentlichten Version nicht prüfbar` };
  }
  if (!response.ok) return { error: `${url} antwortet mit HTTP ${response.status}; Inhalt der veröffentlichten Version nicht prüfbar` };
  const remote = Buffer.from(await response.arrayBuffer());
  if (!remote.equals(localSums)) {
    return {
      error: `Version ${version} ist mit anderem Inhalt veröffentlicht (SHA256SUMS weicht ab). Eine veröffentlichte Version wird nie ersetzt; neue, höhere Version bauen`,
    };
  }
  return {};
}

/**
 * Saves the public stable latest.json as werkterm-updates-<version>.json in dir. An identical
 * existing backup is kept; a different one is never overwritten (a timestamped name is used).
 * Returns { path, version, existing? } or { none: true } when stable has no latest.json yet;
 * throws on errors.
 */
export async function backupLatest({ dir, status, fetchImpl = fetch, now = new Date() }) {
  let response;
  try {
    response = await fetchImpl(LATEST_URL, { redirect: "error", signal: AbortSignal.timeout(30000) });
  } catch (error) {
    throw new Error(`${LATEST_URL} nicht abrufbar: ${error.message}`);
  }
  if (response.status === 404 && status.release === null) return { none: true };
  if (!response.ok) throw new Error(`${LATEST_URL} antwortet mit HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  let version;
  try {
    version = JSON.parse(data.toString("utf8")).version;
  } catch {
    throw new Error(`${LATEST_URL} liefert kein JSON`);
  }
  const name = backupFileName(version);
  mkdirSync(dir, { recursive: true });
  let path = join(dir, name);
  if (existsSync(path)) {
    if (readFileSync(path).equals(data)) return { path, version, existing: true };
    path = join(dir, name.replace(/\.json$/, `-${timestamp(now)}.json`));
  }
  writeFileSync(path, data, { flag: "wx" });
  return { path, version };
}

/** Checks the status after publishing; returns error messages. */
export function verifyFinalStatus({ channel, version, status }) {
  const errors = [];
  if (channel === "stable") {
    if (status.release !== version) errors.push(`stable steht auf ${status.release ?? "-"}, erwartet ${version}`);
    if (!status.apt.includes(version)) errors.push(`APT enthält ${version} nicht`);
  } else if (status.release_test !== version) {
    errors.push(`test steht auf ${status.release_test ?? "-"}, erwartet ${version}`);
  }
  return errors;
}

/**
 * What has changed on the server when the run stops in the given phase: "before" (nothing
 * uploaded yet), "deb", "release" (on stable after a successful deb) or "verify".
 */
export function serverState({ phase, channel, version }) {
  const channelDir = channel === "stable" ? "updates" : "updates-test";
  switch (phase) {
    case "deb":
      return 'Stand: Downloads und latest.json unverändert; das APT-Repo übernimmt das .deb nur bei Erfolg (mit "status werkterm" prüfen). Nach Behebung denselben Aufruf wiederholen.';
    case "release": {
      const deb = channel === "stable" ? `.deb ${version} ist im APT-Repo, ` : "";
      return `Stand: ${deb}latest.json (${channelDir}) unverändert, downloads/${version}/ eventuell schon angelegt. Denselben Aufruf wiederholen (idempotent), sofern der Server keinen Inhaltskonflikt meldet.`;
    }
    case "verify":
      return 'Stand: Uploads abgeschlossen, der Serverstatus entspricht aber nicht der Erwartung. Mit "status werkterm" prüfen.';
    default:
      return "Stand: Auf dem Server ist nichts geändert.";
  }
}

/** Files the release folder must contain (relative paths). */
export function requiredFiles(version) {
  return [...serverFileNames(version), artifactNames(version).deb, `release-${version}.tar`, join("github", SUMS)];
}

/** Local checks of the downloaded release folder, including the tar contents; returns error messages. */
export function verifyLocalRelease(dir, version) {
  const missing = requiredFiles(version).filter(file => !existsSync(join(dir, file)));
  if (missing.length) return missing.map(file => `fehlt: ${file}`);
  const names = serverFileNames(version);
  const hashes = {};
  const texts = {};
  for (const name of names) {
    hashes[name] = sha256File(join(dir, name));
    if (name.endsWith(".sig") || name === SUMS || name === LATEST) texts[name] = readFileSync(join(dir, name), "utf8");
  }
  const looseHashes = Object.fromEntries(Object.entries(hashes).filter(([name]) => name !== SUMS && name !== LATEST));
  const errors = validateServerRelease({ version, names, texts, hashes: looseHashes });
  try {
    errors.push(...validateTarEntries(inspectTar(join(dir, `release-${version}.tar`)), { version, hashes }));
  } catch (error) {
    errors.push(`release-${version}.tar: ${error.message}`);
  }
  const deb = artifactNames(version).deb;
  const githubSums = readFileSync(join(dir, "github", SUMS), "utf8");
  const listed = githubSums.split("\n").map(line => line.replace(/^[0-9a-fA-F]{64} [ *]/, "")).filter(Boolean);
  const packageHashes = {};
  for (const name of listed) if (existsSync(join(dir, name))) packageHashes[name] = sha256File(join(dir, name));
  errors.push(
    ...validateSha256Sums(githubSums, {
      allowed: new Set(Object.values(artifactNames(version))),
      required: [deb],
      hashes: packageHashes,
      label: `github/${SUMS}`,
    }),
  );
  return errors;
}

function step(number, total, text) {
  console.log(`\n[${number}/${total}] ${text}`);
}

/** Runs a program; resolves { code, stdout }. stdin from inputPath, stderr is shown as is. */
function run(program, args, { inputPath, capture = false } = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(program, args, { stdio: [inputPath ? "pipe" : "ignore", capture ? "pipe" : "inherit", "inherit"] });
    let stdout = "";
    if (capture) child.stdout.on("data", chunk => (stdout += chunk));
    if (inputPath) {
      // The server may stop reading early (rejected input); its exit code tells why.
      child.stdin.on("error", () => {});
      const input = createReadStream(inputPath);
      input.on("error", error => {
        console.error(`Lesen fehlgeschlagen: ${inputPath}: ${error.message}`);
        child.stdin.destroy();
      });
      input.pipe(child.stdin);
    }
    child.on("error", error => resolvePromise({ code: 127, stdout, error }));
    child.on("close", (code, signal) => resolvePromise({ code: code ?? (signal ? 1 : 0), stdout }));
  });
}

async function main() {
  let options;
  try {
    options = parsePublishArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const { version, channel, host, dryRun } = options;
  const stable = channel === "stable";
  const context = { phase: "before" };
  const fail = (message, code = 1) => {
    console.error(`Abbruch: ${message}`);
    if (!dryRun) console.error(serverState({ phase: context.phase, channel, version }));
    if (context.backup) console.error(`Sicherung der latest.json: ${context.backup}`);
    process.exit(code);
  };
  const runChecked = async (program, args, label, runOptions) => {
    const result = await run(program, args, runOptions);
    if (result.error) fail(`${program} nicht ausführbar: ${result.error.message}`, result.code);
    if (result.code !== 0) fail(`${label} endete mit Exit ${result.code}`, result.code);
    return result;
  };
  const serverStatus = async () => {
    const command = remoteCommand("status");
    const { stdout } = await runChecked("ssh", sshArgs(host, command), `ssh "${command}"`, { capture: true });
    try {
      return parseStatus(stdout.trim());
    } catch (error) {
      fail(error.message);
    }
  };

  const cache = cacheDir(version);
  const total = stable ? 6 : 5;
  let number = 0;
  console.log(`Werkterm ${version} veröffentlichen, Kanal ${channel}, SSH-Alias ${host}${dryRun ? " (Probelauf, nur Befehle)" : ""}`);

  step(++number, total, "Artefakt bereitstellen");
  let dir;
  if (options.from !== undefined) {
    dir = resolve(options.from);
    console.log(`  Ordner: ${dir}`);
  } else {
    dir = join(cache, `run-${options.run}`);
    if (dryRun) {
      console.log(`  ${displayCommand("gh", ghDownloadArgs(options.run, version, `${dir}.download-XXXXXX`))}`);
      console.log(`  danach umbenennen in ${dir}`);
    } else if (existsSync(dir) && readdirSync(dir).length) {
      console.log(`  Verwende vorhandenen Download: ${dir}`);
    } else {
      // Download into a fresh folder and rename it only after success, so a broken download
      // never looks like a complete one.
      mkdirSync(cache, { recursive: true });
      const partial = mkdtempSync(join(cache, `run-${options.run}.download-`));
      const args = ghDownloadArgs(options.run, version, partial);
      console.log(`  ${displayCommand("gh", args)}`);
      const result = await run("gh", args);
      if (result.error || result.code !== 0) {
        rmSync(partial, { recursive: true, force: true });
        fail(result.error ? `gh nicht ausführbar: ${result.error.message}` : `gh run download endete mit Exit ${result.code}`, result.code || 1);
      }
      if (existsSync(dir)) rmdirSync(dir);
      renameSync(partial, dir);
      console.log(`  Gespeichert: ${dir}`);
    }
  }

  step(++number, total, "Dateien, Prüfsummen und tar-Inhalt prüfen");
  if (dryRun && !existsSync(dir)) console.log("  Übersprungen: Ordner fehlt im Probelauf");
  else {
    const errors = verifyLocalRelease(dir, version);
    if (errors.length) fail(`Release-Ordner ungültig:\n  ${errors.join("\n  ")}`);
    console.log("  Dateien vollständig; SHA256SUMS, github/SHA256SUMS, latest.json und tar-Inhalt stimmen");
  }

  const tar = join(dir, `release-${version}.tar`);
  const deb = join(dir, artifactNames(version).deb);
  const statusCommand = remoteCommand("status");
  const debCommand = remoteCommand("deb", version);
  const releaseCommand = remoteCommand(releaseKind(channel), version);
  const backups = backupDir();

  step(++number, total, "Serverstatus abfragen");
  if (dryRun) {
    console.log(`  ${displayCommand("ssh", sshArgs(host, statusCommand))}`);
    console.log(`  Falls downloads/${version}/ existiert: GET ${publishedSumsUrl(version)}, mit lokalem SHA256SUMS vergleichen`);
    if (stable) console.log(`  Sicherung: GET ${LATEST_URL} -> ${join(backups, "werkterm-updates-<version>.json")}`);
  } else {
    const status = await serverStatus();
    console.log(formatStatus(status));
    const check = preflight({ channel, version, status });
    if (check.error) fail(check.error);
    for (const note of check.notes) console.log(`  Hinweis: ${note}`);
    if (check.compareDownloads) {
      const compared = await comparePublishedSums({ version, localSums: readFileSync(join(dir, SUMS)) });
      if (compared.error) fail(compared.error);
      console.log(`  downloads/${version}/ ist schon veröffentlicht und identisch (Wiederholungslauf)`);
    }
    if (stable) {
      try {
        const saved = await backupLatest({ dir: backups, status });
        if (saved.none) console.log("  Keine latest.json auf stable vorhanden, keine Sicherung nötig");
        else {
          context.backup = saved.path;
          console.log(`  ${saved.existing ? "Bereits gesichert" : "Gesichert"}: latest.json (Version ${saved.version}) in ${saved.path}`);
        }
      } catch (error) {
        fail(error.message);
      }
    }
  }

  if (stable) {
    step(++number, total, ".deb ins APT-Repository laden");
    console.log(`  ${displayCommand("ssh", sshArgs(host, debCommand), deb)}`);
    if (!dryRun) {
      context.phase = "deb";
      await runChecked("ssh", sshArgs(host, debCommand), `ssh "${debCommand}"`, { inputPath: deb });
    }
  }

  step(++number, total, `Release hochladen (${stable ? "updates" : "updates-test"})`);
  if (!stable) console.log("  .deb wird im Kanal test nicht hochgeladen (APT kennt nur stable)");
  console.log(`  ${displayCommand("ssh", sshArgs(host, releaseCommand), tar)}`);
  if (!dryRun) {
    context.phase = "release";
    await runChecked("ssh", sshArgs(host, releaseCommand), `ssh "${releaseCommand}"`, { inputPath: tar });
  }

  step(++number, total, "Ergebnis prüfen");
  if (dryRun) {
    console.log(`  ${displayCommand("ssh", sshArgs(host, statusCommand))}`);
    console.log("\nProbelauf beendet, nichts veröffentlicht");
    return;
  }
  context.phase = "verify";
  const status = await serverStatus();
  console.log(formatStatus(status));
  const errors = verifyFinalStatus({ channel, version, status });
  if (errors.length) fail(errors.join("; "));
  console.log(`\nWerkterm ${version} ist im Kanal ${channel} veröffentlicht`);
  if (context.backup) console.log(`Sicherung der vorigen latest.json: ${context.backup}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch(error => {
    console.error(`Abbruch: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
