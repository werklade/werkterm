import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LATEST,
  MAX_NOTES,
  NOTES_TRUNCATED,
  SUMS,
  artifactNames,
  buildLatestJson,
  buildSha256Sums,
  cargoPackageVersion,
  changelogSection,
  changelogSubsections,
  checkVersions,
  compareVersions,
  createBundle,
  downloadUrl,
  findInputs,
  formatPubDate,
  inputFileNames,
  inspectTar,
  isValidVersion,
  limitNotes,
  parseBundleArgs,
  parseSha256Sums,
  parseUstarHeader,
  releaseText,
  sanitizeNotes,
  serverFileNames,
  signatureValue,
  validateLatestJson,
  validateServerRelease,
  validateSha256Sums,
  validateTarEntries,
} from "./release-bundle.mjs";

const V = "1.2.3";
const names = artifactNames(V);
const SIG = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==";
const sha = text => createHash("sha256").update(text).digest("hex");
const hasTar = spawnSync("tar", ["--version"]).status === 0;

/** Minimal ustar writer for tests (regular files unless type is given). */
function ustarHeader(name, size, type = "0", magic = "ustar\0") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "latin1");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write(magic, 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}
function buildUstar(entries, { end = true } = {}) {
  const parts = [];
  for (const { name, data = "", type, magic } of entries) {
    const buffer = Buffer.from(data);
    parts.push(ustarHeader(name, buffer.length, type, magic), buffer, Buffer.alloc((512 - (buffer.length % 512)) % 512));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const temps = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "werkterm-release-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Fixed",
  "",
  "- Unreleased fix.",
  "",
  `## [${V}] – 2026-11-13`,
  "",
  "### Fixed",
  "",
  "- A fix.",
  "",
  "### Added",
  "",
  "- A feature.",
  "",
  "## [1.2.2] – 2026-11-01",
  "",
  "### Added",
  "",
  "- Older.",
  "",
  "[1.2.2]: https://example.invalid/1.2.2",
  "",
].join("\n");

function sigTexts() {
  return Object.fromEntries(["appimage", "nsis", "msi"].map(kind => [`${names[kind]}.sig`, `${SIG}\n`]));
}

function validLatest(overrides = {}) {
  const doc = buildLatestJson({
    version: V,
    notes: "Notes",
    pubDate: "2026-11-13T10:00:00Z",
    signatures: { appimage: `${SIG}\n`, nsis: SIG, msi: `${SIG}\n` },
  });
  return JSON.stringify({ ...doc, ...overrides });
}

const allFiles = new Set(serverFileNames(V));

describe("versions", () => {
  it("accepts MAJOR.MINOR.PATCH without leading zeros", () => {
    for (const v of ["0.0.0", "0.1.8", "10.20.30", "999999999.0.1"]) expect(isValidVersion(v)).toBe(true);
    for (const v of ["01.2.3", "1.02.3", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-beta", "1.2.3a", "1000000000.0.0", "", " 1.2.3", undefined]) {
      expect(isValidVersion(v)).toBe(false);
    }
  });

  it("compares numerically per component", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("reads the [package] version from Cargo.toml", () => {
    const toml = '[workspace]\nversion = "9.9.9"\n\n[package]\nname = "werkterm"\nversion = "0.1.8" # current\n\n[dependencies]\nversion = "1"\n';
    expect(cargoPackageVersion(toml)).toBe("0.1.8");
    expect(cargoPackageVersion('[dependencies]\nversion = "1"\n')).toBe(null);
  });

  it("requires equal versions in all files and the tag", () => {
    const sources = v => ({
      packageJson: JSON.stringify({ version: v[0] }),
      cargoToml: `[package]\nversion = "${v[1]}"\n`,
      tauriConf: JSON.stringify({ version: v[2] }),
    });
    expect(checkVersions(sources([V, V, V]))).toBe(V);
    expect(checkVersions({ ...sources([V, V, V]), tag: `v${V}` })).toBe(V);
    expect(() => checkVersions(sources([V, "1.2.4", V]))).toThrow(/Cargo.toml=1.2.4/);
    expect(() => checkVersions({ ...sources([V, V, V]), tag: "v1.2.4" })).toThrow(/Tag/);
    expect(() => checkVersions({ ...sources([V, V, V]), tag: V })).toThrow(/Tag/);
    expect(() => checkVersions(sources(["01.2.3", "01.2.3", "01.2.3"]))).toThrow(/ungültig/);
  });
});

describe("parseBundleArgs", () => {
  it("parses both forms and rejects mixed or incomplete calls", () => {
    expect(parseBundleArgs(["--version", V, "--in", "a", "--out", "b"])).toEqual({ version: V, in: "a", out: "b" });
    expect(parseBundleArgs(["--print-version", "--tag", "v1.2.3"])).toEqual({ printVersion: true, tag: "v1.2.3" });
    expect(() => parseBundleArgs(["--version", V, "--in", "a"])).toThrow();
    expect(() => parseBundleArgs(["--print-version", "--version", V])).toThrow();
    expect(parseBundleArgs(["--version", V, "--in", "a", "--out", "b", "--require-changelog-section"]).requireSection).toBe(true);
    expect(() => parseBundleArgs(["--print-version", "--require-changelog-section"])).toThrow();
    expect(() => parseBundleArgs(["--version"])).toThrow(/Wert/);
    expect(() => parseBundleArgs(["--foo"])).toThrow(/Unbekannt/);
  });
});

describe("CHANGELOG", () => {
  it("returns the version section without link references", () => {
    const section = changelogSection(CHANGELOG, V);
    expect(section.label).toBe(V);
    expect(section.body).toBe("### Fixed\n\n- A fix.\n\n### Added\n\n- A feature.");
    expect(changelogSection(CHANGELOG, "1.2.2").body).toBe("### Added\n\n- Older.");
  });

  it("falls back to Unreleased and returns null without either", () => {
    expect(changelogSection(CHANGELOG, "9.9.9")).toEqual({ label: "Unreleased", body: "### Fixed\n\n- Unreleased fix." });
    expect(changelogSection("# Changelog\n\n## [1.0.0]\n", "2.0.0")).toBe(null);
  });

  it("does not match a version prefix", () => {
    expect(changelogSection("## [1.2.30]\n\n- x\n", "1.2.3")).toBe(null);
  });

  it("splits subsections", () => {
    expect(changelogSubsections(changelogSection(CHANGELOG, V).body)).toEqual([
      { name: "Fixed", text: "- A fix." },
      { name: "Added", text: "- A feature." },
    ]);
  });
});

describe("notes", () => {
  it("removes control characters except tab and newline", () => {
    expect(sanitizeNotes("a\r\nb\u0007c\td\u007f\u0085e\u001b[0m\n")).toBe("a\nbc\tde[0m");
  });

  it("keeps short notes and truncates long ones by code points", () => {
    expect(limitNotes("short")).toEqual({ notes: "short", truncated: false });
    const long = "😀".repeat(MAX_NOTES + 10);
    const { notes, truncated } = limitNotes(long);
    expect(truncated).toBe(true);
    expect([...notes].length).toBeLessThanOrEqual(MAX_NOTES);
    expect(notes.endsWith(NOTES_TRUNCATED)).toBe(true);
    const lines = Array.from({ length: 4000 }, (_, i) => `- line ${i}`).join("\n");
    const cut = limitNotes(lines).notes;
    expect([...cut].length).toBeLessThanOrEqual(MAX_NOTES);
    expect(cut.slice(0, -NOTES_TRUNCATED.length)).toMatch(/- line \d+$/);
  });
});

describe("latest.json", () => {
  it("builds the platforms in protocol form", () => {
    const doc = JSON.parse(validLatest());
    expect(Object.keys(doc)).toEqual(["version", "notes", "pub_date", "platforms"]);
    expect(Object.keys(doc.platforms)).toEqual(["linux-x86_64-appimage", "windows-x86_64-nsis", "windows-x86_64-msi"]);
    expect(doc.platforms["windows-x86_64-nsis"]).toEqual({
      url: `https://pkg.werklade.de/werkterm/downloads/${V}/Werkterm_${V}_x64-setup.exe`,
      signature: SIG,
    });
    expect(doc.platforms["linux-x86_64-appimage"].url).toBe(downloadUrl(V, `Werkterm_${V}_amd64.AppImage`));
  });

  it("strips exactly one trailing newline from signatures", () => {
    expect(signatureValue("abc\n")).toBe("abc");
    expect(signatureValue("abc\n\n")).toBe("abc\n");
    expect(signatureValue("abc")).toBe("abc");
  });

  it("formats pub_date as RFC 3339 UTC without fractions", () => {
    expect(formatPubDate(new Date(Date.UTC(2026, 10, 13, 9, 8, 7, 654)))).toBe("2026-11-13T09:08:07Z");
  });

  it("accepts a valid document", () => {
    expect(validateLatestJson(validLatest(), { version: V, sigTexts: sigTexts(), files: allFiles })).toEqual([]);
  });

  const invalid = [
    ["broken JSON", "{", /kein gültiges JSON/],
    ["array", "[]", /kein JSON-Objekt/],
    ["extra key", validLatest({ channel: "stable" }), /unerlaubte Schlüssel: channel/],
    ["other version", validLatest({ version: "1.2.4" }), /version ist "1.2.4"/],
    ["notes not a string", validLatest({ notes: 5 }), /notes ist kein String/],
    ["notes too long", validLatest({ notes: "x".repeat(MAX_NOTES + 1) }), /notes länger/],
    ["notes with control char", validLatest({ notes: "a\u0000b" }), /Steuerzeichen/],
    ["notes with C1", validLatest({ notes: "a\u0085b" }), /Steuerzeichen/],
    ["bad pub_date", validLatest({ pub_date: "2026-11-13 10:00:00" }), /pub_date/],
    ["empty platforms", validLatest({ platforms: {} }), /platforms fehlt/],
    ["deb platform", validLatest({ platforms: { "linux-x86_64-deb": { url: "x", signature: SIG } } }), /unerlaubte Plattform linux-x86_64-deb/],
    ["plain linux platform", validLatest({ platforms: { "linux-x86_64": { url: "x", signature: SIG } } }), /unerlaubte Plattform/],
  ];
  for (const [label, text, pattern] of invalid) {
    it(`rejects ${label}`, () => {
      expect(validateLatestJson(text, { version: V, sigTexts: sigTexts(), files: allFiles }).join("\n")).toMatch(pattern);
    });
  }

  const platform = (entry, key = "windows-x86_64-nsis") => validLatest({ platforms: { [key]: entry } });
  const nsisUrl = downloadUrl(V, names.nsis);
  it("rejects wrong platform entries", () => {
    const check = text => validateLatestJson(text, { version: V, sigTexts: sigTexts(), files: allFiles }).join("\n");
    expect(check(platform({ url: nsisUrl }))).toMatch(/genau url und signature/);
    expect(check(platform({ url: nsisUrl, signature: SIG, extra: 1 }))).toMatch(/genau url und signature/);
    expect(check(platform({ url: downloadUrl(V, names.msi), signature: SIG }))).toMatch(/url ist nicht/);
    expect(check(platform({ url: `${nsisUrl}\n`, signature: SIG }))).toMatch(/url ist nicht/);
    expect(check(platform({ url: nsisUrl.replace("https", "http"), signature: SIG }))).toMatch(/url ist nicht/);
    expect(check(platform({ url: nsisUrl, signature: "" }))).toMatch(/unerlaubten Zeichen/);
    expect(check(platform({ url: nsisUrl, signature: `${SIG}\n` }))).toMatch(/unerlaubten Zeichen/);
    expect(check(platform({ url: nsisUrl, signature: "abc$" }))).toMatch(/unerlaubten Zeichen/);
    expect(check(platform({ url: nsisUrl, signature: "AAAA" }))).toMatch(/stimmt nicht/);
  });

  it("requires artifact and .sig in the release", () => {
    const files = new Set([...allFiles].filter(name => name !== `${names.nsis}.sig`));
    expect(validateLatestJson(validLatest(), { version: V, sigTexts: sigTexts(), files }).join("\n")).toMatch(/windows-x86_64-nsis: .* fehlt/);
  });
});

describe("SHA256SUMS", () => {
  const allowed = new Set(serverFileNames(V));
  const hashes = { [names.nsis]: sha("a"), [`${names.nsis}.sig`]: sha("b") };
  const good = buildSha256Sums(Object.entries(hashes));
  const required = Object.keys(hashes);

  it("builds and parses both line forms", () => {
    expect(good).toBe(`${sha("a")}  ${names.nsis}\n${sha("b")}  ${names.nsis}.sig\n`);
    const parsed = parseSha256Sums(`${sha("a").toUpperCase()} *${names.nsis}\n`);
    expect(parsed).toEqual({ entries: [{ hash: sha("a"), name: names.nsis }], errors: [] });
  });

  it("accepts a matching file", () => {
    expect(validateSha256Sums(good, { allowed, required, hashes })).toEqual([]);
  });

  it("rejects bad lines, foreign names, duplicates, gaps and wrong hashes", () => {
    const check = text => validateSha256Sums(text, { allowed, required, hashes }).join("\n");
    expect(check(`${good}garbage\n`)).toMatch(/Zeile 3 ungültig/);
    expect(check(`${good}${sha("c")}  evil.sh\n`)).toMatch(/unerlaubter Name evil.sh/);
    expect(check(`${good}${sha("c")}  ${LATEST}\n`)).toMatch(/unerlaubter Name latest.json/);
    expect(check(`${good}${sha("a")}  ${names.nsis}\n`)).toMatch(/doppelt/);
    expect(check(`${sha("a")}  ${names.nsis}\n`)).toMatch(/\.sig nicht abgedeckt/);
    expect(check(`${sha("x")}  ${names.nsis}\n${sha("b")}  ${names.nsis}.sig\n`)).toMatch(/Prüfsumme von .* stimmt nicht/);
    expect(check(`${good}${sha("c")}  ${names.msi}\n`)).toMatch(/nicht vorhanden/);
  });
});

describe("validateServerRelease", () => {
  function release(drop = []) {
    const names = serverFileNames(V).filter(name => !drop.includes(name));
    const hashes = {};
    for (const name of names) if (name !== SUMS && name !== LATEST) hashes[name] = sha(name);
    const texts = { ...sigTexts(), [SUMS]: buildSha256Sums(Object.entries(hashes)), [LATEST]: validLatest() };
    return { version: V, names, texts, hashes };
  }

  it("accepts a complete release", () => {
    expect(validateServerRelease(release())).toEqual([]);
  });

  it("rejects .sig without artifact, missing sig everywhere and foreign files", () => {
    expect(validateServerRelease(release([names.msi])).join("\n")).toMatch(/\.msi\.sig ohne Artefakt/);
    const noSigs = release(serverFileNames(V).filter(name => name.endsWith(".sig")));
    expect(validateServerRelease(noSigs).join("\n")).toMatch(/kein Artefakt mit \.sig/);
    const foreign = release();
    foreign.names.push(names.deb);
    expect(validateServerRelease(foreign).join("\n")).toMatch(/unerlaubte Datei im Release: Werkterm_1.2.3_amd64.deb/);
    expect(validateServerRelease(release([LATEST])).join("\n")).toMatch(/latest.json fehlt/);
  });

  it("finds SHA256SUMS and latest.json errors", () => {
    const bad = release();
    bad.hashes[names.appimage] = sha("other");
    expect(validateServerRelease(bad).join("\n")).toMatch(/Prüfsumme von Werkterm_1.2.3_amd64.AppImage/);
  });
});

describe("release text", () => {
  it("orders sections and lists the downloads", () => {
    const text = releaseText({ version: V, section: changelogSection(CHANGELOG, V) });
    expect(text.startsWith(`# Werkterm ${V}\n`)).toBe(true);
    expect(text.indexOf("## Added")).toBeLessThan(text.indexOf("## Fixed"));
    for (const name of Object.values(names)) expect(text).toContain(name);
    expect(text).toContain("APT");
  });
});

function fakeInput(dir, { skip = [] } = {}) {
  const linux = join(dir, "linux");
  const windows = join(dir, "windows");
  mkdirSync(linux, { recursive: true });
  mkdirSync(windows, { recursive: true });
  const content = {
    [names.appimage]: "appimage",
    [`${names.appimage}.sig`]: `${SIG}\n`,
    [names.deb]: "deb",
    [names.nsis]: "nsis",
    [`${names.nsis}.sig`]: SIG,
    [names.msi]: "msi",
    [`${names.msi}.sig`]: `${SIG}\n`,
  };
  for (const [name, text] of Object.entries(content)) {
    if (skip.includes(name)) continue;
    writeFileSync(join(name.includes("_x64") ? windows : linux, name), text);
  }
}

describe("findInputs", () => {
  it("finds files recursively and reports missing or duplicate ones", () => {
    const dir = tempDir();
    fakeInput(dir);
    expect(findInputs(dir, inputFileNames(V)).size).toBe(7);
    writeFileSync(join(dir, names.deb), "again");
    expect(() => findInputs(dir, inputFileNames(V))).toThrow(/mehrfach: Werkterm_1.2.3_amd64.deb/);
    const other = tempDir();
    fakeInput(other, { skip: [`${names.msi}.sig`] });
    expect(() => findInputs(other, inputFileNames(V))).toThrow(/fehlt: Werkterm_1.2.3_x64_en-US.msi.sig/);
  });
});

describe("tar inspection", () => {
  const sha256 = text => createHash("sha256").update(text).digest("hex");
  const releaseEntries = () => serverFileNames(V).map(name => ({ name, data: `content of ${name}` }));
  const releaseHashes = () => Object.fromEntries(serverFileNames(V).map(name => [name, sha256(`content of ${name}`)]));
  function write(buffer) {
    const path = join(tempDir(), "r.tar");
    writeFileSync(path, buffer);
    return path;
  }

  it("reads names, sizes, types and content hashes", () => {
    const entries = inspectTar(write(buildUstar([{ name: "a.txt", data: "x".repeat(600) }, { name: "b", data: "" }])));
    expect(entries).toEqual([
      { name: "a.txt", size: 600, type: "0", sha256: sha256("x".repeat(600)) },
      { name: "b", size: 0, type: "0", sha256: sha256("") },
    ]);
  });

  it("accepts a complete release tar, also with ./ names", () => {
    expect(validateTarEntries(inspectTar(write(buildUstar(releaseEntries()))), { version: V, hashes: releaseHashes() })).toEqual([]);
    const dotted = releaseEntries().map(entry => ({ ...entry, name: `./${entry.name}` }));
    expect(validateTarEntries(inspectTar(write(buildUstar(dotted))), { version: V, hashes: releaseHashes() })).toEqual([]);
  });

  it("rejects broken headers and archives", () => {
    const good = buildUstar([{ name: "a", data: "abc" }]);
    const badSum = Buffer.from(good);
    badSum[0] = 0x62;
    expect(() => parseUstarHeader(badSum.subarray(0, 512))).toThrow(/Prüfsumme/);
    expect(() => inspectTar(write(buildUstar([{ name: "a", data: "abc", magic: "xxxxx\0" }])))).toThrow(/kein ustar/);
    expect(() => inspectTar(write(buildUstar([{ name: "a", data: "abc" }], { end: false })))).toThrow(/Endmarke/);
    expect(() => inspectTar(write(good.subarray(0, 512 + 2)))).toThrow(/abgeschnitten/);
    expect(parseUstarHeader(Buffer.alloc(512))).toBe(null);
  });

  it("rejects links, directories, foreign names, duplicates, gaps and changed content", () => {
    const hashes = releaseHashes();
    const check = entries => validateTarEntries(inspectTar(write(buildUstar(entries))), { version: V, hashes }).join("\n");
    expect(check([...releaseEntries(), { name: "dir/", type: "5" }])).toMatch(/dir\/ ist keine reguläre Datei/);
    expect(check([...releaseEntries(), { name: LATEST, type: "2" }])).toMatch(/keine reguläre Datei \(Typ 2\)/);
    expect(check([...releaseEntries(), { name: "evil.sh", data: "x" }])).toMatch(/unerlaubter Name evil.sh/);
    expect(check([...releaseEntries(), { name: SUMS, data: `content of ${SUMS}` }])).toMatch(/SHA256SUMS doppelt/);
    expect(check(releaseEntries().filter(entry => entry.name !== LATEST))).toMatch(/latest.json fehlt/);
    const changed = releaseEntries().map(entry => (entry.name === names.msi ? { ...entry, data: "other" } : entry));
    expect(check(changed)).toMatch(/x64_en-US.msi weicht von der geprüften Datei ab/);
  });

  it.skipIf(!hasTar)("reads an archive written by the system tar", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "one.txt"), "one");
    expect(spawnSync("tar", ["--format=ustar", "-cf", "x.tar", "--", "one.txt"], { cwd: dir }).status).toBe(0);
    expect(inspectTar(join(dir, "x.tar"))).toMatchObject([{ name: "one.txt", size: 3, type: "0" }]);
  });
});

describe("createBundle", () => {
  it("requires the version section when asked to", () => {
    const input = tempDir();
    fakeInput(input);
    const out = join(tempDir(), "out");
    expect(() => createBundle({ version: "9.9.9", inDir: input, outDir: out, changelog: CHANGELOG, requireSection: true })).toThrow(/## \[9.9.9\] fehlt/);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a non-empty output folder and invalid versions", () => {
    const input = tempDir();
    fakeInput(input);
    const out = tempDir();
    writeFileSync(join(out, "keep.txt"), "user data");
    expect(() => createBundle({ version: V, inDir: input, outDir: out, changelog: CHANGELOG })).toThrow(/nicht leer/);
    expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("user data");
    expect(() => createBundle({ version: "1.02.3", inDir: input, outDir: join(out, "x"), changelog: CHANGELOG })).toThrow(/ungültig/);
  });

  it("stops before the tar when a signature is invalid", () => {
    const input = tempDir();
    fakeInput(input);
    writeFileSync(join(input, "windows", `${names.nsis}.sig`), "not base64!");
    const out = join(tempDir(), "out");
    expect(() => createBundle({ version: V, inDir: input, outDir: out, changelog: CHANGELOG })).toThrow(/Prüfung fehlgeschlagen/);
    expect(existsSync(join(out, `release-${V}.tar`))).toBe(false);
  });

  it.skipIf(!hasTar)("writes the release folder and tar", () => {
    const input = tempDir();
    fakeInput(input);
    const out = join(tempDir(), "out");
    const now = new Date(Date.UTC(2026, 10, 13, 12, 0, 0));
    const result = createBundle({ version: V, inDir: input, outDir: out, changelog: CHANGELOG, now });
    expect(result.notesLabel).toBe(V);
    const latest = JSON.parse(readFileSync(join(out, LATEST), "utf8"));
    expect(latest.pub_date).toBe("2026-11-13T12:00:00Z");
    expect(latest.notes).toBe("### Fixed\n\n- A fix.\n\n### Added\n\n- A feature.");
    const sums = readFileSync(join(out, SUMS), "utf8");
    expect(sums).not.toContain(".deb");
    expect(parseSha256Sums(sums).entries).toHaveLength(6);
    const github = readFileSync(join(out, "github", SUMS), "utf8");
    expect(parseSha256Sums(github).entries.map(e => e.name)).toEqual([names.appimage, names.deb, names.nsis, names.msi]);
    expect(github).toContain(`${sha("deb")}  ${names.deb}`);
    expect(readFileSync(join(out, "github", "RELEASE-TEXT.md"), "utf8")).toContain(`# Werkterm ${V}`);
    const listed = spawnSync("tar", ["-tf", `release-${V}.tar`], { cwd: out, encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean);
    expect(listed.sort()).toEqual([...serverFileNames(V)].sort());
    const header = readFileSync(join(out, `release-${V}.tar`)).subarray(257, 262).toString("latin1");
    expect(header).toBe("ustar");
  });
});
