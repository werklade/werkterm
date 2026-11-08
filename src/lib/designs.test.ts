import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDesign, builtInDesigns, contrastRatio, designColorScheme, editorTokens, getDesign, normalizeDesign, registerUserDesign, uiTokens, unregisterUserDesign } from "./designs";
import { ansiKeys } from "./terminalThemes";

afterEach(() => vi.unstubAllGlobals());
describe("design validation", () => {
  it("fills missing and invalid colors without retaining foreign model keys", () => {
    const base = builtInDesigns["Werklade Hell"];
    const result = normalizeDesign({ name: "x".repeat(70), ui: { accent: "#abc", danger: "#12345678", unknown: "#123456" }, terminal: { red: "red", blue: "#AABBCC" }, editor: { keyword: "#abcdef", string: 42 } }, base);
    expect(result.name).toHaveLength(60);
    expect(result.ui.accent).toBe(base.ui.accent);
    expect(result.ui.danger).toBe("#12345678");
    expect(result.ui).not.toHaveProperty("unknown");
    expect(result.terminal.red).toBe(base.terminal.red);
    expect(result.terminal.blue).toBe("#AABBCC");
    expect(result.editor.keyword).toBe("#abcdef");
    expect(result.editor.string).toBe(base.editor.string);
    expect(normalizeDesign(null, base)).toEqual(base);
    expect(base.name).toBe("Werklade Hell");
  });
  it("provides a valid color for every token in every built-in", () => {
    for (const design of Object.values(builtInDesigns)) {
      for (const token of uiTokens) expect(design.ui[token], `${design.name}: ${token}`).toMatch(/^#[\da-f]{6}([\da-f]{2})?$/i);
      for (const token of editorTokens) expect(design.editor[token], `${design.name}: ${token}`).toMatch(/^#[\da-f]{6}([\da-f]{2})?$/i);
      for (const token of [...ansiKeys, "background", "foreground", "cursor", "selectionBackground"] as const) expect(design.terminal[token]).toMatch(/^#[\da-f]{6}([\da-f]{2})?$/i);
    }
    expect(builtInDesigns["Werklade Dunkel"].ui.accent).toBe("#f08a24");
    expect(builtInDesigns["Werklade Hell"].ui["on-accent"]).toBe("#1f2933");
  });
  it("keeps the stored hover colour as button fill for designs saved without accent-hover-fill", () => {
    expect(normalizeDesign({ name: "Alt", ui: { "accent-hover": "#123456" } }).ui["accent-hover-fill"]).toBe("#123456");
    expect(normalizeDesign({ name: "Neu", ui: { "accent-hover": "#123456", "accent-hover-fill": "#abcdef" } }).ui["accent-hover-fill"]).toBe("#abcdef");
    expect(builtInDesigns["Werklade Hell"].ui["accent-hover-fill"]).toBe("#e07d22");
  });
  it("resolves registered user designs and safely falls back for unknown names", () => {
    const design = normalizeDesign({ name: "Custom", ui: { accent: "#123456" } });
    registerUserDesign("custom-1", design);
    expect(getDesign("Custom")).toEqual(design);
    unregisterUserDesign("custom-1");
    expect(getDesign("Custom")).toBe(builtInDesigns["Werklade Dunkel"]);
    expect(getDesign("toString")).toBe(builtInDesigns["Werklade Dunkel"]);
  });
});
describe("design rendering and contrast", () => {
  it("uses the specified luminance threshold and sets all variable groups", () => {
    expect(designColorScheme(normalizeDesign({ ui: { "bg-app": "#8c8c8c" } }))).toBe("dark");
    expect(designColorScheme(normalizeDesign({ ui: { "bg-app": "#8d8d8d" } }))).toBe("light");
    const style = { setProperty: vi.fn(), colorScheme: "" };
    vi.stubGlobal("document", { documentElement: { style } });
    const design = builtInDesigns["Werklade Hell"];
    applyDesign(design);
    expect(style.colorScheme).toBe("light");
    expect(style.setProperty).toHaveBeenCalledWith("--accent", design.ui.accent);
    expect(style.setProperty).toHaveBeenCalledWith("--editor-keyword", design.editor.keyword);
    expect(style.setProperty).toHaveBeenCalledWith("--term-bg", design.terminal.background);
    expect(style.setProperty).toHaveBeenCalledWith("--term-bright-red", design.terminal.brightRed);
    expect(style.setProperty).toHaveBeenCalledWith("--term-selection", design.terminal.selectionBackground);
  });
  it("computes WCAG contrast including alpha compositing", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21);
    expect(contrastRatio("#123456", "#123456")).toBeCloseTo(1);
    expect(contrastRatio("#ffffff00", "#000000")).toBeCloseTo(1);
    expect(contrastRatio("#ffffff80", "#000000")).toBeGreaterThan(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });
});
