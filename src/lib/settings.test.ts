import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, loadSettings, normalizeSettings, saveSettings, selectedTheme } from "./settings";
describe("settings validation and migration", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("defaults invalid and old settings without losing existing booleans", () => {
    for (const input of [null, [], "invalid", 42]) expect(normalizeSettings(input)).toEqual(defaultSettings);
    expect(normalizeSettings({ followTerminalFolder: false, sshPromptCommand: false })).toEqual({ ...defaultSettings, followTerminalFolder: false, sshPromptCommand: false });
  });
  it("clamps bounds and rejects invalid values", () => {
    const value = normalizeSettings({ fontSize: 99, editorFontSize: -1, lineHeight: 9, scrollback: -5, cursorStyle: "invalid", editorTabSize: 3, theme: "toString", monitoring: "false" });
    expect(value).toMatchObject({ fontSize: 32, editorFontSize: 8, lineHeight: 2, scrollback: 1000, cursorStyle: "block", editorTabSize: 4, monitoring: true, theme: "Werkterm Dunkel" });
    expect(normalizeSettings({ fontSize: NaN, scrollback: Infinity, fontFamily: " " })).toEqual(defaultSettings);
    expect(normalizeSettings({ fontSize: 8, editorFontSize: 32, lineHeight: 1, scrollback: 100000, editorTabSize: 8 })).toMatchObject({ fontSize: 8, editorFontSize: 32, lineHeight: 1, scrollback: 100000, editorTabSize: 8 });
  });
  it("migrates the previous storage key and tolerates storage errors", () => {
    const getItem = vi.fn((key: string) => key === "linmoba.settings" ? '{"shellIntegration":false}' : null);
    vi.stubGlobal("localStorage", { getItem, setItem: vi.fn() });
    expect(loadSettings().shellIntegration).toBe(false);
    vi.stubGlobal("localStorage", { getItem: () => { throw Error("denied"); }, setItem: () => { throw Error("quota"); } });
    expect(loadSettings()).toEqual(defaultSettings);
    expect(() => saveSettings(defaultSettings)).not.toThrow();
  });
  it("persists and validates the selected split layout", () => {
    let stored = "";
    vi.stubGlobal("localStorage", { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } });
    saveSettings({ ...defaultSettings, splitMode: "quad" });
    expect(loadSettings().splitMode).toBe("quad");
    for (const value of [null, 4, "invalid"]) expect(normalizeSettings({ splitMode: value }).splitMode).toBe("single");
  });
  it("validates and preserves imported themes", () => {
    const settings = normalizeSettings({ theme: "MobaXterm (importiert)", importedTheme: { red: "#123abc", blue: "invalid", background: "#eeeeee" } });
    expect(selectedTheme(settings).red).toBe("#123abc");
    expect(selectedTheme(settings).blue).toBe("#1769ff");
    expect(selectedTheme(settings).background).toBe("#eeeeee");
    expect(normalizeSettings({ theme: "MobaXterm (importiert)" }).theme).toBe(defaultSettings.theme);
  });
});
