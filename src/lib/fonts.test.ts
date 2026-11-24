import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { buildFontFamily, firstFontFamily, fontFamilyMatches, groupImportedFonts, importedFontsSnapshot, isDefaultFontFamily, isKnownFontFamily, loadImportedFonts, registerImportedFont, unregisterImportedFont, visibleSystemFonts, type ImportedFont } from "./fonts";
import { defaultSettings } from "./settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const face = (id: string, family: string, extra: Partial<ImportedFont> = {}): ImportedFont => ({ id, family, monospaced: true, weight: 400, style: "normal", ...extra });

describe("font lists", () => {
  it("groups faces of one family case-insensitively", () => {
    const groups = groupImportedFonts([face("b", "Hack"), face("a1", "Fira Code"), face("a2", "fira code", { weight: 700, monospaced: false, broken: true })]);
    expect(groups.map(group => [group.family, group.ids, group.broken])).toEqual([["Fira Code", ["a1", "a2"], true], ["Hack", ["b"], false]]);
  });
  it("hides system families shadowed by an imported one, ignoring case", () => {
    const system = [{ family: "fira code", monospaced: true }, { family: "Consolas", monospaced: true }, { family: "CONSOLAS", monospaced: true }, { family: "Arial", monospaced: false }];
    expect(visibleSystemFonts(system, new Set(["fira code"]), false).map(font => font.family)).toEqual(["Consolas"]);
    expect(visibleSystemFonts(system, new Set(), false, "arial").map(font => font.family)).toEqual(["fira code", "Consolas", "Arial"]);
    expect(visibleSystemFonts(system, new Set(), true)).toHaveLength(3);
  });
  it("matches a stored family case-insensitively", () => {
    expect(fontFamilyMatches('"fira code", monospace', "Fira Code")).toBe(true);
    expect(fontFamilyMatches('"Hack", monospace', "Fira Code")).toBe(false);
  });
});

describe("imported font registration", () => {
  const added: unknown[] = [];
  const deleted: unknown[] = [];
  const created: { family: string; descriptors?: FontFaceDescriptors }[] = [];
  let failLoad = false;
  beforeEach(() => {
    added.length = 0; deleted.length = 0; created.length = 0; failLoad = false;
    vi.stubGlobal("document", { fonts: { add: (f: unknown) => added.push(f), delete: (f: unknown) => deleted.push(f) } });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("FontFace", class {
      family: string; descriptors?: FontFaceDescriptors;
      constructor(family: string, _source: unknown, descriptors?: FontFaceDescriptors) { this.family = family; this.descriptors = descriptors; created.push(this); }
      load() { return failLoad ? Promise.reject(new Error("bad")) : Promise.resolve(this); }
    });
    vi.mocked(invoke).mockReset();
  });
  afterEach(async () => {
    // Drop module state between tests: an empty listing unregisters everything.
    vi.mocked(invoke).mockResolvedValue([]);
    await loadImportedFonts();
    vi.unstubAllGlobals();
  });
  it("shares one FontFace between parallel registrations and passes weight and style", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));
    const font = face("x", "Fira Code", { weight: 700, style: "italic" });
    await Promise.all([registerImportedFont(font), registerImportedFont(font), registerImportedFont(font)]);
    expect(created).toHaveLength(1);
    expect(created[0].descriptors).toEqual({ weight: "700", style: "italic" });
    expect(added).toHaveLength(1);
    await registerImportedFont(font);
    expect(created).toHaveLength(1);
  });
  it("never adds a face that was unregistered while loading", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));
    const running = registerImportedFont(face("x", "Hack"));
    unregisterImportedFont("x");
    await running;
    expect(added).toHaveLength(0);
  });
  it("keeps broken fonts listed and drops removed ones", async () => {
    vi.mocked(invoke).mockImplementation(async command => command === "fonts_list_imported" ? [face("ok", "Hack"), face("bad", "Broken")] : new ArrayBuffer(4));
    const ok = registerImportedFont(face("ok", "Hack")); await ok;
    failLoad = true;
    const list = await loadImportedFonts();
    expect(list.map(font => [font.id, font.broken])).toEqual([["ok", false], ["bad", true]]);
    expect(importedFontsSnapshot().find(font => font.id === "bad")?.broken).toBe(true);
    vi.mocked(invoke).mockResolvedValue([]);
    expect(await loadImportedFonts()).toEqual([]);
    expect(deleted).toHaveLength(1);
  });
  it("rejects when listing fails", async () => {
    vi.mocked(invoke).mockRejectedValue("FONT_READ_FAILED");
    await expect(loadImportedFonts()).rejects.toBe("FONT_READ_FAILED");
  });
});

describe("fonts", () => {
  it("builds a quoted family with monospace fallback", () => {
    expect(buildFontFamily("Fira Code")).toBe('"Fira Code", monospace');
  });
  it("removes quotes and separators from the family", () => {
    expect(buildFontFamily('Evil"; x\\')).toBe('"Evil x", monospace');
  });
  it("falls back to the default for an empty family", () => {
    expect(buildFontFamily('  "" ')).toBe(defaultSettings.fontFamily);
  });
  it("reads the first family", () => {
    expect(firstFontFamily('"Fira Code", monospace')).toBe("Fira Code");
    expect(firstFontFamily(defaultSettings.fontFamily)).toBe("Cascadia Mono");
    expect(firstFontFamily("Consolas, monospace")).toBe("Consolas");
    expect(firstFontFamily("'Ubuntu Mono', monospace")).toBe("Ubuntu Mono");
    expect(firstFontFamily("")).toBe("");
  });
  it("round-trips", () => { expect(firstFontFamily(buildFontFamily("Source Code Pro"))).toBe("Source Code Pro"); });
  it("detects the default value", () => {
    expect(isDefaultFontFamily(defaultSettings.fontFamily)).toBe(true);
    expect(isDefaultFontFamily('"Fira Code", monospace')).toBe(false);
  });
  it("detects custom values", () => {
    expect(isKnownFontFamily('"Fira Code", monospace', ["Fira Code"])).toBe(true);
    expect(isKnownFontFamily(defaultSettings.fontFamily, [])).toBe(true);
    expect(isKnownFontFamily("Consolas", ["Consolas"])).toBe(false);
  });
});
