import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInDesigns, normalizeDesign, registerUserDesign, unregisterUserDesign } from "./designs";
import { defaultSettings, interpretLoaded, loadSettings, mergeSettings, normalizeSettings, saveSettings, selectedTheme, serializeSettings, type Settings } from "./settings";
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
  it("validates remembered paste choices", () => {
    expect(normalizeSettings({}).pasteRemember).toEqual({ global: null, sessions: {} });
    expect(normalizeSettings({ pasteRemember: "x" }).pasteRemember).toEqual({ global: null, sessions: {} });
    const valid = { global: { action: "paste", trim: true }, sessions: { a: { action: "single-line", trim: false }, b: { action: "bad", trim: false } } };
    expect(normalizeSettings({ pasteRemember: valid }).pasteRemember).toEqual({ global: { action: "paste", trim: true }, sessions: { a: { action: "single-line", trim: false } } });
    expect(normalizeSettings(normalizeSettings({ pasteRemember: valid }))).toEqual(normalizeSettings({ pasteRemember: valid }));
  });
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

describe("merging the settings file with the localStorage cache", () => {
  it("prefers the file and ignores the cache", () => {
    const outcome = interpretLoaded('{"fontSize":20}', '{"fontSize":9}');
    expect(outcome).toMatchObject({ ok: true, migrated: false });
    expect(outcome.ok && outcome.settings.fontSize).toBe(20);
  });
  it("adopts the cache once when the file is absent (migration)", () => {
    const outcome = interpretLoaded(null, '{"shellIntegration":false,"fontSize":18}');
    expect(outcome).toMatchObject({ ok: true, migrated: true });
    expect(outcome.ok && outcome.settings).toMatchObject({ shellIntegration: false, fontSize: 18 });
  });
  it("starts with defaults and does not migrate without any cache or with a damaged cache", () => {
    for (const cache of [null, "{broken", "null", "[]"]) {
      const outcome = interpretLoaded(null, cache);
      expect(outcome).toEqual({ ok: true, settings: defaultSettings, migrated: false });
    }
  });
  it("never replaces an unreadable file with defaults", () => {
    for (const text of ["", "{broken", "[]", "42", "null"]) expect(interpretLoaded(text, '{"fontSize":18}').ok).toBe(false);
  });
  it("validates file content like any other input", () => {
    const outcome = interpretLoaded('{"fontSize":99,"cursorStyle":"x"}', null);
    expect(outcome.ok && outcome.settings).toMatchObject({ fontSize: 32, cursorStyle: "block" });
  });
  it("serializes normalized settings as a JSON object", () => {
    const text = serializeSettings({ ...defaultSettings, fontSize: 500 });
    expect(JSON.parse(text)).toMatchObject({ fontSize: 32, design: "Werklade Dunkel" });
  });
});

describe("device-local settings and migration permission", () => {
  it("keeps logFolder out of the file text and takes it from the cache when loading", () => {
    expect(JSON.parse(serializeSettings({ ...defaultSettings, logFolder: "D:/Logs" }))).not.toHaveProperty("logFolder");
    const outcome = interpretLoaded('{"logFolder":"/from/other/device","fontSize":20}', '{"logFolder":"/mine"}');
    expect(outcome.ok && outcome.settings).toMatchObject({ logFolder: "/mine", fontSize: 20 });
    const without = interpretLoaded('{"logFolder":"/from/other/device"}', null);
    expect(without.ok && without.settings.logFolder).toBe("");
  });
  it("does not migrate the cache into a missing file unless allowed", () => {
    const cache = '{"fontSize":18,"logFolder":"/mine"}';
    const denied = interpretLoaded(null, cache, false);
    expect(denied).toMatchObject({ ok: true, migrated: false });
    expect(denied.ok && denied.settings).toMatchObject({ fontSize: defaultSettings.fontSize, logFolder: "/mine" });
    expect(interpretLoaded(null, cache, true)).toMatchObject({ ok: true, migrated: true });
  });
});

describe("mergeSettings (write conflict)", () => {
  const choice = { action: "paste", trim: true } as const;
  const base: Settings = { ...defaultSettings, pasteRemember: { global: null, sessions: { a: choice } } };
  it("keeps keys changed here and takes everything else from the current file", () => {
    const mine = { ...base, fontSize: 16 };
    const theirs = { ...base, tuxCount: 7, cursorStyle: "bar" as const };
    expect(mergeSettings(base, mine, theirs)).toMatchObject({ fontSize: 16, tuxCount: 7, cursorStyle: "bar" });
  });
  it("lets the local change win when both sides changed the same key", () => {
    expect(mergeSettings(base, { ...base, fontSize: 16 }, { ...base, fontSize: 22 }).fontSize).toBe(16);
  });
  it("adopts the file unchanged when nothing was changed here", () => {
    const theirs = { ...base, fontSize: 22, tuxCount: 3 };
    expect(mergeSettings(base, base, theirs)).toEqual(normalizeSettings(theirs));
  });
  it("merges pasteRemember per session entry", () => {
    const mine: Settings = { ...base, pasteRemember: { global: null, sessions: { b: choice } } };
    const theirs: Settings = { ...base, pasteRemember: { global: choice, sessions: { a: choice, c: choice } } };
    const merged = mergeSettings(base, mine, theirs).pasteRemember;
    expect(merged.global).toEqual(choice);
    expect(Object.keys(merged.sessions).sort()).toEqual(["b", "c"]);
  });
  it("lets a local global choice win and clamps through normalization", () => {
    const mine: Settings = { ...base, pasteRemember: { global: { action: "single-line", trim: false }, sessions: base.pasteRemember.sessions } };
    expect(mergeSettings(base, mine, base).pasteRemember.global).toEqual({ action: "single-line", trim: false });
  });
  it("treats every key that differs from the file as changed here when the base is unknown", () => {
    expect(mergeSettings(null, { ...defaultSettings, fontSize: 16 }, { ...defaultSettings, fontSize: 22, tuxCount: 7 })).toMatchObject({ fontSize: 16, tuxCount: defaultSettings.tuxCount });
  });
  it("always keeps the local logFolder", () => {
    expect(mergeSettings(base, { ...base, logFolder: "/mine" }, { ...base, logFolder: "/theirs" }).logFolder).toBe("/mine");
  });
  it("always keeps the local language", () => {
    expect(mergeSettings(base, { ...base, language: "en" }, { ...base, language: "de" }).language).toBe("en");
  });
});

describe("language setting", () => {
  it("defaults to the system language and accepts only known values", () => {
    expect(defaultSettings.language).toBe("system");
    expect(normalizeSettings({}).language).toBe("system");
    for (const language of ["system", "de", "en"] as const) expect(normalizeSettings({ language }).language).toBe(language);
    for (const language of ["fr", "", "EN", null, 1, {}]) expect(normalizeSettings({ language }).language).toBe("system");
  });
  it("stays per device: not written to the file, taken from the cache when loading", () => {
    expect(JSON.parse(serializeSettings({ ...defaultSettings, language: "en" }))).not.toHaveProperty("language");
    const outcome = interpretLoaded('{"language":"de","fontSize":20}', '{"language":"en"}');
    expect(outcome.ok && outcome.settings).toMatchObject({ language: "en", fontSize: 20 });
    const without = interpretLoaded('{"language":"en"}', null);
    expect(without.ok && without.settings.language).toBe("system");
  });
});

it("uses Werklade icons for new installs and Standard for existing settings", () => {
  expect(normalizeSettings(null).iconSet).toBe("Werklade");
  expect(normalizeSettings({}).iconSet).toBe("Standard");
  expect(normalizeSettings({ iconSet: "custom-123" }).iconSet).toBe("custom-123");
  expect(normalizeSettings({ iconSet: 3 }).iconSet).toBe("Standard");
});
