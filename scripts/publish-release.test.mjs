import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOST,
  LATEST_URL,
  MAX_VERSIONS,
  UsageError,
  backupDir,
  backupFileName,
  backupLatest,
  cacheDir,
  comparePublishedSums,
  displayCommand,
  ghDownloadArgs,
  parsePublishArgs,
  parseStatus,
  preflight,
  publishedSumsUrl,
  releaseKind,
  remoteCommand,
  requiredFiles,
  serverState,
  sshArgs,
  verifyFinalStatus,
  verifyLocalRelease,
} from "./publish-release.mjs";
import { LATEST, SUMS, artifactNames, buildLatestJson, buildSha256Sums, serverFileNames } from "./release-bundle.mjs";

const V = "1.2.3";
const SIG = "c2lnbmF0dXJl";

/** Minimal ustar writer (regular files) so the tests need no system tar. */
function buildUstar(entries) {
  const parts = [];
  for (const [name, data] of entries) {
    const body = Buffer.from(data);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "latin1");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** fetch stand-in: maps URL -> { status, body } or an Error to throw; records calls. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body ?? "", { status: route.status ?? 200 });
  };
  impl.calls = calls;
  return impl;
}

const temps = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "werkterm-publish-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

describe("parsePublishArgs", () => {
  it("parses a run download with defaults", () => {
    expect(parsePublishArgs([V, "--channel", "test", "--run", "123"])).toEqual({
      version: V,
      channel: "test",
      run: "123",
      host: DEFAULT_HOST,
      dryRun: false,
    });
  });

  it("parses --from, --host, --dry-run and = forms", () => {
    expect(parsePublishArgs(["--channel=stable", V, "--from", "dist", "--host=pkg-lan", "--dry-run"])).toEqual({
      version: V,
      channel: "stable",
      from: "dist",
      host: "pkg-lan",
      dryRun: true,
    });
  });

  const invalid = [
    [[], /Genau eine Version/],
    [[V, "1.2.4", "--channel", "test", "--run", "1"], /Genau eine Version/],
    [["01.2.3", "--channel", "test", "--run", "1"], /Version ungültig/],
    [["1.2.3;rm", "--channel", "test", "--run", "1"], /Version ungültig/],
    [[V, "--run", "1"], /--channel/],
    [[V, "--channel", "beta", "--run", "1"], /--channel/],
    [[V, "--channel", "test"], /--run/],
    [[V, "--channel", "test", "--run", "1", "--from", "x"], /nicht zusammen/],
    [[V, "--channel", "test", "--run", "12a"], /Run-ID/],
    [[V, "--channel", "test", "--run", "1", "--host", "-oProxyCommand=x"], /SSH-Alias/],
    [[V, "--channel", "test", "--run", "1", "--host", "a b"], /SSH-Alias/],
    [[V, "--channel", "test", "--run"], /braucht einen Wert/],
    [[V, "--channel", "test", "--run", "1", "--force"], /Unbekannte Option/],
    [[V, "--channel", "test", "--from", ""], /Ordner/],
  ];
  for (const [argv, pattern] of invalid) {
    it(`rejects ${JSON.stringify(argv)}`, () => {
      expect(() => parsePublishArgs(argv)).toThrow(UsageError);
      expect(() => parsePublishArgs(argv)).toThrow(pattern);
    });
  }

  it("returns help without further checks", () => {
    expect(parsePublishArgs(["--help"]).help).toBe(true);
  });
});

describe("commands", () => {
  it("builds remote commands only from fixed words and a valid version", () => {
    expect(remoteCommand("status")).toBe("status werkterm");
    expect(remoteCommand("deb", V)).toBe("deb werkterm 1.2.3");
    expect(remoteCommand("release", V)).toBe("release werkterm 1.2.3");
    expect(remoteCommand(releaseKind("test"), V)).toBe("release-test werkterm 1.2.3");
    expect(releaseKind("stable")).toBe("release");
    expect(() => remoteCommand("shell", V)).toThrow();
    expect(() => remoteCommand("deb", "1.2.3 && id")).toThrow();
    expect(() => remoteCommand("deb", undefined)).toThrow();
  });

  it("passes the alias after -- and as a separate argument", () => {
    expect(sshArgs("werklade-pkg", "status werkterm")).toEqual(["--", "werklade-pkg", "status werkterm"]);
    expect(() => sshArgs("-oProxyCommand=calc", "status werkterm")).toThrow();
  });

  it("builds the gh download call", () => {
    expect(ghDownloadArgs("42", V, "D")).toEqual(["run", "download", "42", "-n", "werkterm-1.2.3", "-D", "D"]);
    expect(() => ghDownloadArgs("42 --repo x", V, "D")).toThrow();
  });

  it("displays commands with quoting and input redirection", () => {
    expect(displayCommand("ssh", sshArgs("werklade-pkg", "deb werkterm 1.2.3"), "C:\\dl dir\\x.deb")).toBe(
      'ssh -- werklade-pkg "deb werkterm 1.2.3" < "C:\\dl dir\\x.deb"',
    );
  });

  it("uses a per-version cache folder and a fixed backup folder", () => {
    expect(cacheDir(V, "base")).toBe(join("base", "werkterm-publish", V));
    expect(backupDir({ platform: "win32", env: { LOCALAPPDATA: "L" }, home: "H" })).toBe(join("L", "werkterm-publish", "backups"));
    expect(backupDir({ platform: "win32", env: {}, home: "H" })).toBe(join("H", "AppData", "Local", "werkterm-publish", "backups"));
    expect(backupDir({ platform: "linux", env: { XDG_STATE_HOME: "S" }, home: "H" })).toBe(join("S", "werkterm-publish", "backups"));
    expect(backupDir({ platform: "linux", env: {}, home: "H" })).toBe(join("H", ".local", "state", "werkterm-publish", "backups"));
  });

  it("names backups after the backed-up version", () => {
    expect(backupFileName("1.2.2")).toBe("werkterm-updates-1.2.2.json");
    expect(() => backupFileName("../x")).toThrow(/ungültig/);
    expect(() => backupFileName(undefined)).toThrow(/ungültig/);
  });
});

const status = overrides =>
  parseStatus(
    JSON.stringify({
      product: "werkterm",
      package: "werkterm",
      release: "1.2.2",
      release_test: "1.2.3",
      downloads: ["1.2.2", "1.2.3"],
      apt: ["1.2.2"],
      withdrawn: [],
      ...overrides,
    }),
  );

describe("server status", () => {
  it("parses the status line and rejects other content", () => {
    expect(status({}).release).toBe("1.2.2");
    expect(status({ release: null, withdrawn: undefined }).withdrawn).toEqual([]);
    expect(() => parseStatus("not json")).toThrow(/kein JSON/);
    expect(() => parseStatus(JSON.stringify({ product: "other", release: null, release_test: null, downloads: [], apt: [] }))).toThrow(/Format/);
    expect(() => status({ apt: "1.2.2" })).toThrow(/Format/);
  });

  it("blocks downgrades and withdrawn versions on stable", () => {
    expect(preflight({ channel: "stable", version: "1.2.4", status: status({}) })).toEqual({ notes: [], compareDownloads: false });
    expect(preflight({ channel: "stable", version: "1.2.4", status: status({ release: null, apt: [] }) })).toEqual({ notes: [], compareDownloads: false });
    expect(preflight({ channel: "stable", version: V, status: status({ release: "1.2.10" }) }).error).toMatch(/Downgrade/);
    expect(preflight({ channel: "stable", version: V, status: status({ release: V }) }).notes[0]).toMatch(/Wiederholung/);
    expect(preflight({ channel: "stable", version: V, status: status({ apt: ["1.3.0"] }) }).error).toMatch(/APT/);
    expect(preflight({ channel: "stable", version: V, status: status({ withdrawn: [V] }) }).error).toMatch(/zurückgenommen/);
    expect(preflight({ channel: "test", version: V, status: status({ withdrawn: [V] }) }).error).toMatch(/zurückgenommen/);
  });

  it("allows any version on the test channel", () => {
    expect(preflight({ channel: "test", version: "0.0.1", status: status({ release: "9.0.0", apt: ["9.0.0"] }) })).toEqual({ notes: [], compareDownloads: false });
  });

  it("asks for a content comparison when downloads/<v>/ exists", () => {
    expect(preflight({ channel: "test", version: V, status: status({}) }).compareDownloads).toBe(true);
    expect(preflight({ channel: "stable", version: V, status: status({ release: V, apt: [V] }) }).compareDownloads).toBe(true);
  });

  it("stops at the server limit of version folders, unless the version is a repeat", () => {
    const full = Array.from({ length: MAX_VERSIONS }, (_, i) => `0.0.${i}`);
    expect(preflight({ channel: "test", version: V, status: status({ downloads: full }) }).error).toMatch(/40 Versionsordner/);
    expect(preflight({ channel: "test", version: "0.0.5", status: status({ release: null, downloads: full }) }).error).toBeUndefined();
    expect(preflight({ channel: "test", version: V, status: status({ downloads: full.slice(1) }) }).error).toBeUndefined();
  });

  it("verifies the result per channel", () => {
    expect(verifyFinalStatus({ channel: "test", version: V, status: status({}) })).toEqual([]);
    expect(verifyFinalStatus({ channel: "stable", version: V, status: status({ release: V, apt: [V] }) })).toEqual([]);
    expect(verifyFinalStatus({ channel: "stable", version: V, status: status({ release: V }) })).toEqual(["APT enthält 1.2.3 nicht"]);
    expect(verifyFinalStatus({ channel: "stable", version: V, status: status({ apt: [V] }) })[0]).toMatch(/stable steht auf 1.2.2/);
    expect(verifyFinalStatus({ channel: "test", version: V, status: status({ release_test: null }) })[0]).toMatch(/test steht auf -/);
  });
});

describe("published content", () => {
  const url = publishedSumsUrl(V);
  const local = Buffer.from("abc  x\n");

  it("accepts identical SHA256SUMS", async () => {
    const fetchImpl = fakeFetch({ [url]: { body: "abc  x\n" } });
    expect(await comparePublishedSums({ version: V, localSums: local, fetchImpl })).toEqual({});
    expect(fetchImpl.calls[0].url).toBe("https://pkg.werklade.de/werkterm/downloads/1.2.3/SHA256SUMS");
    expect(fetchImpl.calls[0].options.redirect).toBe("error");
  });

  it("stops on different content, HTTP errors and network errors", async () => {
    const differ = await comparePublishedSums({ version: V, localSums: local, fetchImpl: fakeFetch({ [url]: { body: "abc  x\r\n" } }) });
    expect(differ.error).toMatch(/mit anderem Inhalt veröffentlicht/);
    expect((await comparePublishedSums({ version: V, localSums: local, fetchImpl: fakeFetch({}) })).error).toMatch(/HTTP 404/);
    expect((await comparePublishedSums({ version: V, localSums: local, fetchImpl: fakeFetch({ [url]: new Error("offline") }) })).error).toMatch(/offline/);
  });
});

describe("backupLatest", () => {
  const body = JSON.stringify({ version: "1.2.2", platforms: {} });

  it("saves the public latest.json under the version name", async () => {
    const dir = join(tempDir(), "backups");
    const saved = await backupLatest({ dir, status: status({}), fetchImpl: fakeFetch({ [LATEST_URL]: { body } }) });
    expect(saved).toEqual({ path: join(dir, "werkterm-updates-1.2.2.json"), version: "1.2.2" });
    expect(readFileSync(saved.path, "utf8")).toBe(body);
  });

  it("keeps an identical backup and never overwrites a different one", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "werkterm-updates-1.2.2.json"), body);
    const same = await backupLatest({ dir, status: status({}), fetchImpl: fakeFetch({ [LATEST_URL]: { body } }) });
    expect(same.existing).toBe(true);
    writeFileSync(join(dir, "werkterm-updates-1.2.2.json"), "older copy");
    const now = new Date(Date.UTC(2026, 10, 13, 9, 8, 7));
    const other = await backupLatest({ dir, status: status({}), fetchImpl: fakeFetch({ [LATEST_URL]: { body } }), now });
    expect(other.path).toBe(join(dir, "werkterm-updates-1.2.2-20261113T090807Z.json"));
    expect(readFileSync(join(dir, "werkterm-updates-1.2.2.json"), "utf8")).toBe("older copy");
  });

  it("needs no backup without a stable release, but fails otherwise", async () => {
    const dir = join(tempDir(), "b");
    expect(await backupLatest({ dir, status: status({ release: null }), fetchImpl: fakeFetch({}) })).toEqual({ none: true });
    expect(existsSync(dir)).toBe(false);
    await expect(backupLatest({ dir, status: status({}), fetchImpl: fakeFetch({}) })).rejects.toThrow(/HTTP 404/);
    await expect(backupLatest({ dir, status: status({}), fetchImpl: fakeFetch({ [LATEST_URL]: { body: "{" } }) })).rejects.toThrow(/kein JSON/);
    const bad = JSON.stringify({ version: "../../evil" });
    await expect(backupLatest({ dir, status: status({}), fetchImpl: fakeFetch({ [LATEST_URL]: { body: bad } }) })).rejects.toThrow(/ungültig/);
    await expect(backupLatest({ dir, status: status({}), fetchImpl: fakeFetch({ [LATEST_URL]: new Error("offline") }) })).rejects.toThrow(/offline/);
  });
});

describe("serverState", () => {
  it("names what has changed on the server for each phase", () => {
    expect(serverState({ phase: "before", channel: "stable", version: V })).toMatch(/nichts geändert/);
    expect(serverState({ phase: "deb", channel: "stable", version: V })).toMatch(/Downloads und latest.json unverändert/);
    const release = serverState({ phase: "release", channel: "stable", version: V });
    expect(release).toMatch(/\.deb 1\.2\.3 ist im APT-Repo/);
    expect(release).toMatch(/latest.json \(updates\) unverändert/);
    expect(release).toMatch(/idempotent/);
    const test = serverState({ phase: "release", channel: "test", version: V });
    expect(test).not.toMatch(/APT/);
    expect(test).toMatch(/updates-test/);
    expect(serverState({ phase: "verify", channel: "test", version: V })).toMatch(/Uploads abgeschlossen/);
  });
});

describe("verifyLocalRelease", () => {
  const names = artifactNames(V);
  const sha = text => createHash("sha256").update(text).digest("hex");

  function release(dir) {
    mkdirSync(join(dir, "github"));
    const files = {
      [names.appimage]: "appimage",
      [`${names.appimage}.sig`]: `${SIG}\n`,
      [names.nsis]: "nsis",
      [`${names.nsis}.sig`]: SIG,
      [names.msi]: "msi",
      [`${names.msi}.sig`]: SIG,
      [names.deb]: "deb",
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const server = serverFileNames(V).filter(name => name !== SUMS && name !== LATEST);
    writeFileSync(join(dir, SUMS), buildSha256Sums(server.map(name => [name, sha(files[name])])));
    const latest = buildLatestJson({
      version: V,
      notes: "n",
      pubDate: "2026-11-13T00:00:00Z",
      signatures: { appimage: `${SIG}\n`, nsis: SIG, msi: SIG },
    });
    writeFileSync(join(dir, LATEST), JSON.stringify(latest));
    const packages = [names.appimage, names.deb, names.nsis, names.msi];
    writeFileSync(join(dir, "github", SUMS), buildSha256Sums(packages.map(name => [name, sha(files[name])])));
    const tarEntries = serverFileNames(V).map(name => [name, readFileSync(join(dir, name))]);
    writeFileSync(join(dir, `release-${V}.tar`), buildUstar(tarEntries));
    return tarEntries;
  }

  it("accepts a complete folder", () => {
    const dir = tempDir();
    release(dir);
    expect(verifyLocalRelease(dir, V)).toEqual([]);
  });

  it("reports missing files", () => {
    const dir = tempDir();
    expect(verifyLocalRelease(dir, V)).toHaveLength(requiredFiles(V).length);
  });

  it("detects a changed .deb and a changed artifact", () => {
    const dir = tempDir();
    release(dir);
    writeFileSync(join(dir, names.deb), "tampered");
    writeFileSync(join(dir, names.msi), "tampered");
    const errors = verifyLocalRelease(dir, V).join("\n");
    expect(errors).toMatch(/github\/SHA256SUMS: Prüfsumme von Werkterm_1.2.3_amd64.deb/);
    expect(errors).toMatch(/^SHA256SUMS: Prüfsumme von Werkterm_1.2.3_x64_en-US.msi/m);
  });

  it("checks the tar contents against the loose files", () => {
    const dir = tempDir();
    const entries = release(dir);
    const changed = entries.map(([name, data]) => [name, name === names.nsis ? Buffer.from("other") : data]);
    writeFileSync(join(dir, `release-${V}.tar`), buildUstar(changed));
    expect(verifyLocalRelease(dir, V).join("\n")).toMatch(/tar: Werkterm_1.2.3_x64-setup.exe weicht von der geprüften Datei ab/);
    writeFileSync(join(dir, `release-${V}.tar`), buildUstar([...entries, ["extra.txt", "x"]]));
    expect(verifyLocalRelease(dir, V).join("\n")).toMatch(/unerlaubter Name extra.txt/);
    writeFileSync(join(dir, `release-${V}.tar`), "not a tar");
    expect(verifyLocalRelease(dir, V).join("\n")).toMatch(/release-1.2.3.tar: tar:/);
    expect(readdirSync(dir)).toContain(`release-${V}.tar`);
  });

  it("detects a version mismatch in latest.json", () => {
    const dir = tempDir();
    release(dir);
    writeFileSync(join(dir, LATEST), JSON.stringify({ version: "1.2.4", platforms: {} }));
    expect(verifyLocalRelease(dir, V).join("\n")).toMatch(/version ist "1.2.4"/);
  });
});
