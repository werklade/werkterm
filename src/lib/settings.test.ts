import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInDesigns, normalizeDesign, registerUserDesign, unregisterUserDesign } from "./designs";
import { defaultSettings, loadSettings, normalizeSettings, saveSettings, selectedTheme } from "./settings";
it("normalizes Tux settings with defaults and finite minute bounds", () => {
  expect(normalizeSettings({})).toMatchObject({ tuxEnabled: true, tuxIdleMinutes: 10 });
  expect(normalizeSettings({ tuxEnabled: false, tuxIdleMinutes: 121 })).toMatchObject({ tuxEnabled: false, tuxIdleMinutes: 120 });
  expect(normalizeSettings({ tuxIdleMinutes: -1 }).tuxIdleMinutes).toBe(1);
  expect(normalizeSettings({}).tuxCount).toBe(4);
  expect(normalizeSettings({ tuxCount: 12 }).tuxCount).toBe(8);
  expect(normalizeSettings({ tuxCount: 0 }).tuxCount).toBe(1);
  expect(normalizeSettings({ tuxIdleMinutes: 1.6 }).tuxIdleMinutes).toBe(2);
  for (const value of [NaN, Infinity, "5", null]) expect(normalizeSettings({ tuxEnabled: "false", tuxIdleMinutes: value })).toMatchObject({ tuxEnabled: true, tuxIdleMinutes: 10 });
});
describe("settings validation and migration", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("defaults invalid and old settings without losing existing booleans", () => {
    for (const input of [null, [], "invalid", 42]) expect(normalizeSettings(input)).toEqual(defaultSettings);
    expect(normalizeSettings({ followTerminalFolder: false, sshPromptCommand: false })).toEqual({ ...defaultSettings, design: "Werkterm Dunkel", iconSet: "Standard", theme: "Werkterm Dunkel", followTerminalFolder: false, sshPromptCommand: false });
  });
  it("clamps bounds and rejects invalid values", () => {
    const value = normalizeSettings({ fontSize: 99, editorFontSize: -1, lineHeight: 9, scrollback: -5, cursorStyle: "invalid", editorTabSize: 3, theme: "toString", monitoring: "false" });
    expect(value).toMatchObject({ fontSize: 32, editorFontSize: 8, lineHeight: 2, scrollback: 1000, cursorStyle: "block", editorTabSize: 4, monitoring: true, theme: defaultSettings.theme });
    expect(normalizeSettings({ fontSize: NaN, scrollback: Infinity, fontFamily: " " })).toEqual({ ...defaultSettings, design: "Werkterm Dunkel", iconSet: "Standard", theme: "Werkterm Dunkel" });
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
  it("validates logging and paste preferences", () => {
    expect(normalizeSettings({ logAllSessions: true, logStripAnsi: false, logFolder: "D:/Logs", pasteConfirm: "never" })).toMatchObject({ logAllSessions: true, logStripAnsi: false, logFolder: "D:/Logs", pasteConfirm: "never" });
    expect(normalizeSettings({ logAllSessions: "true", logStripAnsi: null, logFolder: 123, pasteConfirm: "unknown" })).toMatchObject({ logAllSessions: false, logStripAnsi: true, logFolder: "", pasteConfirm: "multiline" });
  });
  it("validates and preserves imported themes", () => {
    const settings = normalizeSettings({ theme: "MobaXterm (importiert)", importedTheme: { red: "#123abc", blue: "invalid", background: "#eeeeee" } });
    expect(selectedTheme(settings).red).toBe("#123abc");
    expect(selectedTheme(settings).blue).toBe("#1769ff");
    expect(selectedTheme(settings).background).toBe("#eeeeee");
    expect(normalizeSettings({ theme: "MobaXterm (importiert)" }).theme).toBe(defaultSettings.theme);
  });
});

it("normalizes terminal selection and right-click settings", () => {
  expect(normalizeSettings({})).toMatchObject({ copyOnSelect: true, rightClick: "menu" });
  expect(normalizeSettings({ copyOnSelect: false, rightClick: "paste" })).toMatchObject({ copyOnSelect: false, rightClick: "paste" });
  expect(normalizeSettings({ copyOnSelect: "false", rightClick: "invalid" })).toMatchObject({ copyOnSelect: true, rightClick: "menu" });
});

describe("design settings migration", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses Werklade with design terminal colors only for new installs", () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    expect(loadSettings()).toMatchObject({ design: "Werklade Dunkel", theme: "design" });
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === "werkterm.settings" ? "{}" : null });
    expect(loadSettings()).toMatchObject({ design: "Werkterm Dunkel", iconSet: "Standard", theme: "Werkterm Dunkel" });
    expect(normalizeSettings({ theme: "Solarized Dark" })).toMatchObject({ design: "Werkterm Dunkel", iconSet: "Standard", theme: "Solarized Dark" });
  });
  it("takes terminal colors from the active built-in or user design", () => {
    const settings = normalizeSettings({ design: "Werklade Hell", theme: "design" });
    expect(selectedTheme(settings)).toEqual(builtInDesigns["Werklade Hell"].terminal);
    const user = normalizeDesign({ name: "User colors", terminal: { background: "#123456" } });
    registerUserDesign("user-colors", user);
    expect(selectedTheme({ ...settings, design: user.name }).background).toBe("#123456");
    unregisterUserDesign("user-colors");
    expect(selectedTheme({ ...settings, design: "unknown" })).toEqual(builtInDesigns["Werklade Dunkel"].terminal);
  });
});

it("uses Werklade icons for new installs and Standard for existing settings", () => {
  expect(normalizeSettings(null).iconSet).toBe("Werklade");
  expect(normalizeSettings({}).iconSet).toBe("Standard");
  expect(normalizeSettings({ iconSet: "custom-123" }).iconSet).toBe("custom-123");
  expect(normalizeSettings({ iconSet: 3 }).iconSet).toBe("Standard");
});
