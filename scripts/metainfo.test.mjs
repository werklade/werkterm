import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Checks the AppStream metainfo shipped in the .deb against tauri.conf.json and package.json.
// Full schema validation runs in CI with appstreamcli (.github/workflows/release.yml).

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");
const tauriConf = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const metainfoTarget = `/usr/share/metainfo/${tauriConf.identifier}.metainfo.xml`;
const metainfoPath = join(tauriDir, "linux", `${tauriConf.identifier}.metainfo.xml`);

/**
 * Minimal well-formedness check without an XML dependency: one optional declaration,
 * comments, balanced start/end tags, a single root element, quoted attributes and only
 * the predefined or numeric entities. Returns a list of problems (empty = ok).
 */
function xmlProblems(xml) {
  const problems = [];
  const body = xml.replace(/^﻿?<\?xml[^?]*\?>/, "");
  if (/<\?xml/.test(body)) problems.push("misplaced XML declaration");
  const stripped = body.replace(/<!--[\s\S]*?-->/g, match => {
    if (match.slice(4, -3).includes("--")) problems.push("'--' inside comment");
    return "";
  });
  if (/<!--|<!\[CDATA\[|<!DOCTYPE/.test(stripped)) problems.push("unclosed comment, CDATA or DOCTYPE");

  const stack = [];
  let roots = 0;
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g;
  let last = 0;
  let match;
  const checkText = text => {
    if (text.includes("<")) problems.push(`stray markup in text: ${text.trim().slice(0, 40)}`);
    for (const entity of text.match(/&[^;\s]*;?/g) ?? []) {
      if (!/^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/.test(entity)) problems.push(`bad entity ${entity}`);
    }
    if (stack.length === 0 && text.trim() !== "") problems.push("text outside the root element");
  };
  while ((match = tag.exec(stripped)) !== null) {
    checkText(stripped.slice(last, match.index));
    last = tag.lastIndex;
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      if (selfClosing) problems.push(`malformed end tag ${name}`);
      const open = stack.pop();
      if (open !== name) problems.push(`end tag ${name} does not match ${open ?? "nothing"}`);
    } else {
      if (stack.length === 0) roots += 1;
      if (!selfClosing) stack.push(name);
    }
  }
  checkText(stripped.slice(last));
  if (stack.length) problems.push(`unclosed elements: ${stack.join(", ")}`);
  if (roots !== 1) problems.push(`expected one root element, found ${roots}`);
  return problems;
}

/** Text content of the first top-level child <name> of <component> (without xml:lang). */
function element(xml, name) {
  const match = xml.match(new RegExp(`<${name}(?:\\s+(?!xml:lang)[^>]*)?>([^<]*)</${name}>`));
  return match ? match[1].trim() : undefined;
}

describe("AppStream metainfo", () => {
  const xml = existsSync(metainfoPath) ? readFileSync(metainfoPath, "utf8") : "";

  it("exists next to the desktop template", () => {
    expect(existsSync(metainfoPath)).toBe(true);
  });

  it("is well-formed XML with a desktop-application root", () => {
    expect(xmlProblems(xml)).toEqual([]);
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toMatch(/<component type="desktop-application">/);
  });

  it("uses the identifier and the desktop file name from tauri.conf.json", () => {
    expect(element(xml, "id")).toBe(tauriConf.identifier);
    expect(xml).toContain(`<launchable type="desktop-id">${tauriConf.productName}.desktop</launchable>`);
    expect(xml).toContain(`<binary>${tauriConf.mainBinaryName}</binary>`);
  });

  it("names metadata and project license", () => {
    expect(element(xml, "metadata_license")).toBe("CC0-1.0");
    expect(element(xml, "project_license")).toBe(tauriConf.bundle.license);
  });

  it("lists the current version as the top release with an ISO date", () => {
    const releases = [...xml.matchAll(/<release\s+([^>]*?)\/?>/g)].map(m => ({
      version: m[1].match(/version="([^"]*)"/)?.[1],
      date: m[1].match(/date="([^"]*)"/)?.[1],
    }));
    expect(releases.length).toBeGreaterThan(0);
    expect(releases[0].version).toBe(pkg.version);
    expect(releases[0].version).toBe(tauriConf.version);
    for (const { date } of releases) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${date}T00:00:00Z`))).toBe(false);
    }
    const versions = releases.map(r => r.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("marks the top release as final once CHANGELOG has a section for it", () => {
    const head = xml.match(/<release\s+[^>]*>/)[0];
    const date = head.match(/date="([^"]*)"/)?.[1];
    const escaped = pkg.version.replace(/\./g, "\\.");
    const section = readFileSync(join(root, "CHANGELOG.md"), "utf8").match(
      new RegExp(`^## \\[${escaped}\\] – (\\d{4}-\\d{2}-\\d{2})`, "m"),
    );
    if (section) {
      expect(date).toBe(section[1]);
      expect(head).not.toMatch(/type="development"/);
    } else {
      expect(head).toMatch(/type="development"/);
    }
  });

  it("is installed by the .deb from an existing source file", () => {
    const files = tauriConf.bundle.linux.deb.files ?? {};
    expect(Object.keys(files)).toContain(metainfoTarget);
    const source = resolve(tauriDir, files[metainfoTarget]);
    expect(source).toBe(metainfoPath);
    expect(existsSync(source)).toBe(true);
  });
});

describe("xmlProblems", () => {
  it("accepts a small valid document", () => {
    expect(xmlProblems('<?xml version="1.0"?>\n<!-- c --><a x="1"><b/><c>t &amp; u</c></a>\n')).toEqual([]);
  });

  it("reports unbalanced tags, bad entities and several roots", () => {
    expect(xmlProblems("<a><b></a>")).not.toEqual([]);
    expect(xmlProblems("<a>&nbsp;</a>")).not.toEqual([]);
    expect(xmlProblems("<a/><b/>")).not.toEqual([]);
    expect(xmlProblems("<a><!-- open </a>")).not.toEqual([]);
    expect(xmlProblems("<a x=1></a>")).not.toEqual([]);
  });
});
