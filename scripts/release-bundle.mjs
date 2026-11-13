// Builds the release folder from the CI build artifacts:
//   <out>/                 artifacts, .sig files, SHA256SUMS (server), latest.json, release-<v>.tar
//   <out>/github/          SHA256SUMS over all packages (incl. .deb) and RELEASE-TEXT.md
// The tar contains exactly the names the publish script on pkg.werklade.de accepts
// (../packages docs/publish-protokoll.md); everything is validated by the same rules first.
// Usage:
//   node scripts/release-bundle.mjs --version <v> --in <dir> --out <dir>
//   node scripts/release-bundle.mjs --print-version [--tag <git tag>]
// The second form checks that package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
// (and the tag, if given) carry the same version and prints it.
// Node >= 22, no dependencies. Exit codes: 0 ok, 1 validation error, 2 usage error.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PRODUCT = "werkterm";
export const PREFIX = "Werkterm";
export const BASE_URL = "https://pkg.werklade.de";
/** APT setup script from werklade/packages (client/), attached to every GitHub release by hand. */
export const SETUP_SCRIPT = "werklade-apt-setup.sh";
export const REPO_KEY_FPR = "498E F081 BBC7 50A1 11DB  2EDA E0CD AE7D 9332 A76C";
export const MAX_NOTES = 20000;
export const SUMS = "SHA256SUMS";
export const LATEST = "latest.json";
export const NOTES_TRUNCATED = "\n\n(Truncated. The full list is in CHANGELOG.md.)";

const VERSION_RE = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const SIGNATURE_RE = /^[A-Za-z0-9+/=]+$/;
const PUB_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// C0 controls except tab and newline, DEL and C1 controls (the server rejects them in notes).
const NOTES_CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const TOP_KEYS = ["version", "notes", "pub_date", "platforms"];

/** Updater platform key -> artifact kind; order is the order in latest.json. */
export const PLATFORMS = {
  "linux-x86_64-appimage": "appimage",
  "windows-x86_64-nsis": "nsis",
  "windows-x86_64-msi": "msi",
};

export function isValidVersion(version) {
  return typeof version === "string" && VERSION_RE.test(version);
}

/** Numeric comparison per component: negative, 0 or positive. Both versions must be valid. */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

export function artifactNames(version) {
  return {
    appimage: `${PREFIX}_${version}_amd64.AppImage`,
    nsis: `${PREFIX}_${version}_x64-setup.exe`,
    msi: `${PREFIX}_${version}_x64_en-US.msi`,
    deb: `${PREFIX}_${version}_amd64.deb`,
  };
}

/** Updater artifacts (the ones with a .sig and a latest.json entry), in latest.json order. */
export function updaterArtifacts(version) {
  const names = artifactNames(version);
  return Object.values(PLATFORMS).map(kind => names[kind]);
}

/** All file names the server accepts in the release tar. */
export function serverFileNames(version) {
  return [...updaterArtifacts(version).flatMap(name => [name, `${name}.sig`]), SUMS, LATEST];
}

/** Input files the bundle needs from the CI artifacts. */
export function inputFileNames(version) {
  return [...updaterArtifacts(version).flatMap(name => [name, `${name}.sig`]), artifactNames(version).deb];
}

export function downloadUrl(version, name) {
  return `${BASE_URL}/${PRODUCT}/downloads/${version}/${name}`;
}

/** Version from the [package] table of a Cargo.toml (null when missing). */
export function cargoPackageVersion(text) {
  let inPackage = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inPackage = /^\[package\]\s*(#.*)?$/.test(line);
      continue;
    }
    if (!inPackage) continue;
    const match = /^version\s*=\s*"([^"]*)"\s*(#.*)?$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

/** Checks that all version sources agree (and the tag, if given); returns the version or throws. */
export function checkVersions({ packageJson, cargoToml, tauriConf, tag }) {
  const sources = {
    "package.json": JSON.parse(packageJson).version,
    "src-tauri/Cargo.toml": cargoPackageVersion(cargoToml),
    "src-tauri/tauri.conf.json": JSON.parse(tauriConf).version,
  };
  const version = sources["package.json"];
  const differing = Object.entries(sources).filter(([, v]) => v !== version);
  if (differing.length) {
    throw new Error(`Versionen ungleich: ${Object.entries(sources).map(([file, v]) => `${file}=${v ?? "fehlt"}`).join(", ")}`);
  }
  if (!isValidVersion(version)) throw new Error(`Version ungültig (erwartet MAJOR.MINOR.PATCH ohne führende Nullen): ${version}`);
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Tag ${tag} passt nicht zur Version ${version} (erwartet v${version})`);
  return version;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Body of the CHANGELOG section "## [<version>]", falling back to "## [Unreleased]".
 * Returns { label, body } or null. Link reference lines at the end are dropped.
 */
export function changelogSection(text, version) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (const label of [version, "Unreleased"]) {
    const heading = new RegExp(`^## \\[${escapeRegExp(label)}\\](\\s|$)`);
    const start = lines.findIndex(line => heading.test(line));
    if (start < 0) continue;
    let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
    if (end < 0) end = lines.length;
    const body = lines.slice(start + 1, end);
    while (body.length && (!body.at(-1).trim() || /^\[[^\]]+\]:\s/.test(body.at(-1)))) body.pop();
    return { label, body: body.join("\n").trim() };
  }
  return null;
}

/** Subsections ("### Added" ...) of a CHANGELOG section body, in their original order. */
export function changelogSubsections(body) {
  const sections = [];
  let current = null;
  for (const line of body.split("\n")) {
    const match = /^### (.+?)\s*$/.exec(line);
    if (match) {
      current = { name: match[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections.map(({ name, lines }) => ({ name, text: lines.join("\n").trim() })).filter(s => s.text);
}

/** Removes characters the server rejects in notes and normalizes line endings. */
export function sanitizeNotes(text) {
  return text.replace(/\r\n?/g, "\n").replace(NOTES_CONTROL_RE, "").trim();
}

/** Limits notes to max code points (as jq counts them), cutting at a line break and adding a hint. */
export function limitNotes(text, max = MAX_NOTES) {
  const chars = [...text];
  if (chars.length <= max) return { notes: text, truncated: false };
  let head = chars.slice(0, max - [...NOTES_TRUNCATED].length).join("");
  const lineBreak = head.lastIndexOf("\n");
  if (lineBreak > head.length / 2) head = head.slice(0, lineBreak);
  return { notes: head.trimEnd() + NOTES_TRUNCATED, truncated: true };
}

/** latest.json signature value: .sig content without exactly one optional trailing "\n". */
export function signatureValue(sigText) {
  return sigText.endsWith("\n") ? sigText.slice(0, -1) : sigText;
}

/** RFC 3339 UTC timestamp without fractional seconds. */
export function formatPubDate(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** latest.json object; signatures maps artifact kind (appimage/nsis/msi) to the raw .sig text. */
export function buildLatestJson({ version, notes, pubDate, signatures }) {
  const names = artifactNames(version);
  const platforms = {};
  for (const [key, kind] of Object.entries(PLATFORMS)) {
    if (signatures[kind] === undefined) continue;
    platforms[key] = { url: downloadUrl(version, names[kind]), signature: signatureValue(signatures[kind]) };
  }
  return { version, notes, pub_date: pubDate, platforms };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Server rules for latest.json. sigTexts maps .sig file names to their raw content,
 * files is the set of names in the release. Returns a list of error messages.
 */
export function validateLatestJson(text, { version, sigTexts = {}, files = new Set() }) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return [`${LATEST}: kein gültiges JSON (${error.message})`];
  }
  if (!isPlainObject(doc)) return [`${LATEST}: kein JSON-Objekt`];
  const errors = [];
  const extra = Object.keys(doc).filter(key => !TOP_KEYS.includes(key));
  if (extra.length) errors.push(`${LATEST}: unerlaubte Schlüssel: ${extra.join(", ")}`);
  if (doc.version !== version) errors.push(`${LATEST}: version ist ${JSON.stringify(doc.version)}, erwartet ${version}`);
  if ("notes" in doc) {
    if (typeof doc.notes !== "string") errors.push(`${LATEST}: notes ist kein String`);
    else {
      if ([...doc.notes].length > MAX_NOTES) errors.push(`${LATEST}: notes länger als ${MAX_NOTES} Zeichen`);
      if (new RegExp(NOTES_CONTROL_RE.source).test(doc.notes)) errors.push(`${LATEST}: notes enthält Steuerzeichen`);
    }
  }
  if ("pub_date" in doc) {
    if (typeof doc.pub_date !== "string" || !PUB_DATE_RE.test(doc.pub_date) || Number.isNaN(Date.parse(doc.pub_date))) {
      errors.push(`${LATEST}: pub_date ist kein RFC-3339-Zeitpunkt`);
    }
  }
  if (!isPlainObject(doc.platforms) || !Object.keys(doc.platforms).length) {
    errors.push(`${LATEST}: platforms fehlt oder ist leer`);
    return errors;
  }
  const names = artifactNames(version);
  for (const [key, entry] of Object.entries(doc.platforms)) {
    const kind = PLATFORMS[key];
    if (!kind) {
      errors.push(`${LATEST}: unerlaubte Plattform ${key}`);
      continue;
    }
    if (!isPlainObject(entry) || Object.keys(entry).sort().join(",") !== "signature,url") {
      errors.push(`${LATEST}: ${key} braucht genau url und signature`);
      continue;
    }
    const name = names[kind];
    if (entry.url !== downloadUrl(version, name)) errors.push(`${LATEST}: ${key}.url ist nicht ${downloadUrl(version, name)}`);
    if (!files.has(name) || !files.has(`${name}.sig`)) errors.push(`${LATEST}: ${key}: ${name} oder ${name}.sig fehlt`);
    if (typeof entry.signature !== "string" || !SIGNATURE_RE.test(entry.signature)) {
      errors.push(`${LATEST}: ${key}.signature leer oder mit unerlaubten Zeichen`);
    } else if (sigTexts[`${name}.sig`] === undefined || entry.signature !== signatureValue(sigTexts[`${name}.sig`])) {
      errors.push(`${LATEST}: ${key}.signature stimmt nicht mit ${name}.sig überein`);
    }
  }
  return errors;
}

/** SHA256SUMS text for [name, hash] pairs: "<sha256>  <name>" per line. */
export function buildSha256Sums(entries) {
  return entries.map(([name, hash]) => `${hash}  ${name}\n`).join("");
}

/** Parses SHA256SUMS ("<hash>  <name>" or "<hash> *<name>"); returns { entries, errors }. */
export function parseSha256Sums(text) {
  const entries = [];
  const errors = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((line, index) => {
    const match = /^([0-9a-fA-F]{64}) [ *]([^\r\n]+)$/.exec(line);
    if (match) entries.push({ hash: match[1].toLowerCase(), name: match[2] });
    else errors.push(`${SUMS}: Zeile ${index + 1} ungültig`);
  });
  return { entries, errors };
}

/**
 * Checks a SHA256SUMS file: valid lines, only allowed names, no duplicates, every required
 * name covered, hashes match (hashes maps name -> sha256 hex). Returns error messages.
 */
export function validateSha256Sums(text, { allowed, required, hashes, label = SUMS }) {
  const { entries, errors } = parseSha256Sums(text);
  const result = errors.map(error => error.replace(SUMS, label));
  const seen = new Set();
  for (const { hash, name } of entries) {
    if (!allowed.has(name) || name === SUMS || name === LATEST) result.push(`${label}: unerlaubter Name ${name}`);
    if (seen.has(name)) result.push(`${label}: ${name} doppelt`);
    seen.add(name);
    if (hashes[name] !== undefined && hashes[name] !== hash) result.push(`${label}: Prüfsumme von ${name} stimmt nicht`);
    else if (hashes[name] === undefined && allowed.has(name)) result.push(`${label}: ${name} nicht vorhanden`);
  }
  for (const name of required) if (!seen.has(name)) result.push(`${label}: ${name} nicht abgedeckt`);
  return result;
}

/**
 * All server checks for the release tar contents. names: file names in the release;
 * texts: content of SHA256SUMS, latest.json and the .sig files; hashes: sha256 per file.
 */
export function validateServerRelease({ version, names, texts, hashes }) {
  const errors = [];
  const allowed = new Set(serverFileNames(version));
  const files = new Set(names);
  for (const name of names) if (!allowed.has(name)) errors.push(`unerlaubte Datei im Release: ${name}`);
  if (files.size !== names.length) errors.push("doppelte Dateinamen im Release");
  for (const name of [SUMS, LATEST]) if (!files.has(name)) errors.push(`${name} fehlt`);
  const artifacts = updaterArtifacts(version);
  for (const name of names) {
    if (name.endsWith(".sig") && !files.has(name.slice(0, -4))) errors.push(`${name} ohne Artefakt`);
  }
  if (!artifacts.some(name => files.has(name) && files.has(`${name}.sig`))) errors.push("kein Artefakt mit .sig");
  if (errors.length) return errors;
  const covered = names.filter(name => name !== SUMS && name !== LATEST);
  errors.push(...validateSha256Sums(texts[SUMS], { allowed, required: covered, hashes }));
  const sigTexts = Object.fromEntries(names.filter(name => name.endsWith(".sig")).map(name => [name, texts[name]]));
  errors.push(...validateLatestJson(texts[LATEST], { version, sigTexts, files }));
  return errors;
}

/** Markdown text for the GitHub pre-release. */
export function releaseText({ version, section }) {
  const names = artifactNames(version);
  const order = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];
  const subsections = changelogSubsections(section?.body ?? "").sort((a, b) => {
    const ia = order.indexOf(a.name);
    const ib = order.indexOf(b.name);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
  });
  const out = [`# Werkterm ${version}`, ""];
  if (subsections.length) for (const { name, text } of subsections) out.push(`## ${name}`, "", text, "");
  else out.push("No changes listed in CHANGELOG.md.", "");
  out.push(
    "## Downloads",
    "",
    `- \`${names.appimage}\`: Linux x86_64, AppImage (updates itself)`,
    `- \`${names.deb}\`: Debian 13, Ubuntu 24.04 and newer (updates via APT)`,
    `- \`${names.nsis}\`: Windows 10/11 x64, installer for the current user (updates itself)`,
    `- \`${names.msi}\`: Windows 10/11 x64, MSI (updates itself)`,
    `- \`${SUMS}\`: SHA-256 checksums, check with \`sha256sum -c ${SUMS}\``,
    "",
    "## Updates",
    "",
    `- APT: the .deb is also available from the APT repository on ${BASE_URL}; installations from there update with \`apt upgrade\`.`,
    `  Set up the repository with \`${SETUP_SCRIPT}\` attached to this release: \`sudo bash ${SETUP_SCRIPT} --install werkterm\` (\`--dry-run\` shows the steps first).`,
    `  The script checks the repository key fingerprint \`${REPO_KEY_FPR}\` before changing anything; manual steps: README, section "APT repository".`,
    `- Updater: AppImage, NSIS and MSI installations find this version under "Hilfe > Nach Updates suchen" (signed update from ${BASE_URL}).`,
    "",
  );
  return out.join("\n");
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Finds each wanted file name exactly once below dir (recursively). Returns name -> path or throws. */
export function findInputs(dir, wanted) {
  const found = new Map(wanted.map(name => [name, []]));
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && found.has(entry.name)) found.get(entry.name).push(path);
    }
  };
  walk(dir);
  const missing = wanted.filter(name => found.get(name).length === 0);
  const duplicate = wanted.filter(name => found.get(name).length > 1);
  if (missing.length || duplicate.length) {
    const parts = [];
    if (missing.length) parts.push(`fehlt: ${missing.join(", ")}`);
    if (duplicate.length) parts.push(`mehrfach: ${duplicate.join(", ")}`);
    throw new Error(`Eingabe ${dir}: ${parts.join("; ")}`);
  }
  return new Map(wanted.map(name => [name, found.get(name)[0]]));
}

function runTar(args, cwd) {
  const result = spawnSync("tar", args, { cwd, encoding: "utf8" });
  if (result.error) throw new Error(`tar nicht ausführbar: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`tar meldet Exit ${result.status}: ${(result.stderr || "").trim()}`);
  return result.stdout;
}

/** Creates <outDir>/<tarName> (uncompressed ustar) with exactly the given names. */
export function writeReleaseTar(outDir, tarName, names) {
  runTar(["--format=ustar", "-cf", tarName, "-C", outDir, "--", ...names], outDir);
}

/**
 * Parses one 512-byte tar header block. Returns null for an all-zero block (end of archive),
 * otherwise { name, size, type }. Only ustar headers with a valid checksum are accepted.
 */
export function parseUstarHeader(block) {
  if (block.length !== 512) throw new Error("tar: unvollständiger Header");
  if (block.every(byte => byte === 0)) return null;
  const field = (start, length) => block.subarray(start, start + length).toString("latin1").replace(/\0.*$/s, "");
  const octal = (start, length, label) => {
    const text = field(start, length).trim();
    if (!/^[0-7]+$/.test(text)) throw new Error(`tar: ${label} im Header ungültig`);
    return parseInt(text, 8);
  };
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  if (octal(148, 8, "Prüfsumme") !== sum) throw new Error("tar: Prüfsumme eines Headers falsch");
  if (field(257, 6) !== "ustar") throw new Error("tar: kein ustar-Header");
  const prefix = field(345, 155);
  const base = field(0, 100);
  return {
    name: prefix ? `${prefix}/${base}` : base,
    size: octal(124, 12, "Größe"),
    type: block[156] === 0 ? "0" : String.fromCharCode(block[156]),
  };
}

/** Reads all entries of an uncompressed ustar file; each with name, size, type and sha256 of the data. */
export function inspectTar(path) {
  const entries = [];
  const fd = openSync(path, "r");
  try {
    const total = fstatSync(fd).size;
    const block = Buffer.alloc(512);
    const chunk = Buffer.alloc(1 << 20);
    let offset = 0;
    for (;;) {
      if (offset + 512 > total) throw new Error("tar: Archiv endet ohne Endmarke");
      readSync(fd, block, 0, 512, offset);
      offset += 512;
      const header = parseUstarHeader(block);
      if (!header) break;
      if (offset + header.size > total) throw new Error(`tar: ${header.name} ist abgeschnitten`);
      const hash = createHash("sha256");
      for (let left = header.size; left > 0; ) {
        const read = readSync(fd, chunk, 0, Math.min(chunk.length, left), offset);
        if (read <= 0) throw new Error(`tar: ${header.name} ist abgeschnitten`);
        hash.update(chunk.subarray(0, read));
        left -= read;
        offset += read;
      }
      offset += (512 - (header.size % 512)) % 512;
      entries.push({ ...header, sha256: hash.digest("hex") });
    }
  } finally {
    closeSync(fd);
  }
  return entries;
}

/**
 * Checks tar entries against the release: only regular files with allowed names, no
 * duplicates, every server file present, content equal to the checked loose files
 * (hashes: name -> sha256 of the loose file). Returns error messages.
 */
export function validateTarEntries(entries, { version, hashes }) {
  const errors = [];
  const allowed = new Set(serverFileNames(version));
  const seen = new Set();
  for (const entry of entries) {
    const name = entry.name.replace(/^\.\//, "");
    if (entry.type !== "0") errors.push(`tar: ${name} ist keine reguläre Datei (Typ ${entry.type})`);
    if (!allowed.has(name)) errors.push(`tar: unerlaubter Name ${name}`);
    else if (seen.has(name)) errors.push(`tar: ${name} doppelt`);
    else if (hashes[name] !== entry.sha256) errors.push(`tar: ${name} weicht von der geprüften Datei ab`);
    seen.add(name);
  }
  for (const name of allowed) if (!seen.has(name)) errors.push(`tar: ${name} fehlt`);
  return errors;
}

/**
 * Builds the complete release folder. Fails before writing the tar if any server rule is
 * violated. Returns { files, notesLabel, truncated }.
 */
export function createBundle({ version, inDir, outDir, changelog, now = new Date(), requireSection = false, log = () => {} }) {
  if (!isValidVersion(version)) throw new Error(`Version ungültig: ${version}`);
  if (existsSync(outDir) && readdirSync(outDir).length) throw new Error(`Ausgabeordner ist nicht leer: ${outDir}`);
  const section = changelogSection(changelog, version);
  if (requireSection && section?.label !== version) throw new Error(`CHANGELOG.md: Abschnitt ## [${version}] fehlt`);
  if (!section) throw new Error(`CHANGELOG.md: weder ## [${version}] noch ## [Unreleased] gefunden`);
  const inputs = findInputs(inDir, inputFileNames(version));
  mkdirSync(join(outDir, "github"), { recursive: true });
  for (const [name, path] of inputs) copyFileSync(path, join(outDir, name));
  log(`Kopiert: ${inputs.size} Dateien`);

  if (section.label !== version) log(`Hinweis: CHANGELOG.md hat keinen Abschnitt ${version}, verwende [Unreleased]`);
  const { notes, truncated } = limitNotes(sanitizeNotes(section.body));
  if (truncated) log(`Hinweis: Release-Notes auf ${MAX_NOTES} Zeichen gekürzt`);

  const names = artifactNames(version);
  const hashes = {};
  for (const name of inputs.keys()) hashes[name] = sha256File(join(outDir, name));
  const serverNames = serverFileNames(version).filter(name => name !== SUMS && name !== LATEST);
  writeFileSync(join(outDir, SUMS), buildSha256Sums(serverNames.map(name => [name, hashes[name]])));
  const signatures = {};
  for (const kind of Object.values(PLATFORMS)) signatures[kind] = readFileSync(join(outDir, `${names[kind]}.sig`), "latin1");
  const latest = buildLatestJson({ version, notes, pubDate: formatPubDate(now), signatures });
  writeFileSync(join(outDir, LATEST), `${JSON.stringify(latest, null, 2)}\n`);

  const tarNames = serverFileNames(version);
  const texts = {};
  for (const name of tarNames) if (name.endsWith(".sig") || name === SUMS || name === LATEST) texts[name] = readFileSync(join(outDir, name), "utf8");
  const errors = validateServerRelease({ version, names: tarNames, texts, hashes });
  if (errors.length) throw new Error(`Prüfung fehlgeschlagen:\n  ${errors.join("\n  ")}`);
  log("Geprüft: SHA256SUMS und latest.json entsprechen den Server-Regeln");

  const packages = [names.appimage, names.deb, names.nsis, names.msi];
  writeFileSync(join(outDir, "github", SUMS), buildSha256Sums(packages.map(name => [name, hashes[name]])));
  writeFileSync(join(outDir, "github", "RELEASE-TEXT.md"), releaseText({ version, section }));

  const tarName = `release-${version}.tar`;
  writeReleaseTar(outDir, tarName, tarNames);
  for (const name of [SUMS, LATEST]) hashes[name] = sha256File(join(outDir, name));
  const tarErrors = validateTarEntries(inspectTar(join(outDir, tarName)), { version, hashes });
  if (tarErrors.length) throw new Error(`${tarName} fehlerhaft:\n  ${tarErrors.join("\n  ")}`);
  log(`Erstellt: ${tarName} (${tarNames.length} Dateien, Inhalt geprüft)`);
  return { files: [...inputs.keys(), SUMS, LATEST, tarName, join("github", SUMS), join("github", "RELEASE-TEXT.md")], notesLabel: section.label, truncated };
}

/** Parses the command line; throws on usage errors. */
export function parseBundleArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--print-version") options.printVersion = true;
    else if (arg === "--require-changelog-section") options.requireSection = true;
    else if (["--version", "--in", "--out", "--tag"].includes(arg)) {
      if (i + 1 >= argv.length) throw new Error(`${arg} braucht einen Wert`);
      options[arg.slice(2)] = argv[++i];
    } else throw new Error(`Unbekanntes Argument: ${arg}`);
  }
  if (options.printVersion) {
    if (options.version || options.in || options.out || options.requireSection) throw new Error("--print-version nur mit --tag kombinierbar");
  } else if (!options.version || !options.in || !options.out || options.tag !== undefined) {
    throw new Error("--version, --in und --out sind Pflicht");
  }
  return options;
}

const USAGE =
  "Aufruf: node scripts/release-bundle.mjs --version <v> --in <ordner> --out <ordner> [--require-changelog-section]\n" +
  "        node scripts/release-bundle.mjs --print-version [--tag <tag>]";

function main() {
  const root = resolve(import.meta.dirname, "..");
  let options;
  try {
    options = parseBundleArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`release-bundle: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
  try {
    if (options.printVersion) {
      const read = file => readFileSync(join(root, file), "utf8");
      console.log(checkVersions({
        packageJson: read("package.json"),
        cargoToml: read(join("src-tauri", "Cargo.toml")),
        tauriConf: read(join("src-tauri", "tauri.conf.json")),
        tag: options.tag,
      }));
      return;
    }
    const inDir = resolve(options.in);
    if (!existsSync(inDir) || !statSync(inDir).isDirectory()) throw new Error(`Eingabeordner fehlt: ${inDir}`);
    const outDir = resolve(options.out);
    const result = createBundle({
      version: options.version,
      inDir,
      outDir,
      changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8"),
      requireSection: options.requireSection === true,
      log: message => console.log(`release-bundle: ${message}`),
    });
    console.log(`release-bundle: fertig in ${outDir} (Notes aus [${result.notesLabel}])`);
    for (const file of result.files) console.log(`  ${file}`);
  } catch (error) {
    console.error(`release-bundle: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
