import { getDesign } from "./designs";
import { ansiKeys, importedThemeId, terminalThemes, type TerminalTheme } from "./terminalThemes";
import { emptyPasteRemember, normalizePasteRemember, type PasteRemember } from "./paste";
import { t, type LanguageSetting } from "../i18n";
export interface Settings {
  design: string;
  iconSet: string;
  tuxEnabled: boolean; tuxIdleMinutes: number; tuxCount: number;
  logFolder: string; logAllSessions: boolean; logStripAnsi: boolean; pasteConfirm: import("./paste").PasteConfirm;
  pasteRemember: PasteRemember;
  copyOnSelect: boolean; rightClick: "menu" | "paste";
  confirmCloseSsh: boolean;
  splitMode: "single" | "columns" | "rows" | "quad";
  bars: "menu" | "toolbar" | "both"; toolbarSize: "small" | "standard" | "labels";
  compact: boolean; sidebarVisible: boolean; sidebarRight: boolean; tabNumbers: boolean; tabClose: boolean;
  followTerminalFolder: boolean; shellIntegration: boolean; sshPromptCommand: boolean; monitoring: boolean;
  fontFamily: string; fontSize: number; lineHeight: number; cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean; scrollback: number; theme: string; importedTheme?: TerminalTheme;
  editorFontSize: number; editorWrap: boolean; editorTabSize: 2 | 4 | 8;
  /** Opt-in: one update check at program start. Off by default; Werkterm opens no connection the user did not allow. */
  updateCheckOnStart: boolean;
  /** UI language; "system" follows the OS locale. Per device (see localOnlyKeys). */
  language: LanguageSetting;
}
export const defaultSettings: Settings = {
  design: "Werklade Dunkel",
  iconSet: "Werklade",
  tuxEnabled: true, tuxIdleMinutes: 10, tuxCount: 4,
  logFolder: "", logAllSessions: false, logStripAnsi: true, pasteConfirm: "multiline", pasteRemember: emptyPasteRemember(),
  copyOnSelect: true, rightClick: "menu",
  confirmCloseSsh: true,
  splitMode: "single",
  bars: "both", toolbarSize: "labels", compact: false, sidebarVisible: true, sidebarRight: false, tabNumbers: false, tabClose: true,
  followTerminalFolder: true, shellIntegration: true, sshPromptCommand: true, monitoring: true,
  fontFamily: '"Cascadia Mono", "DejaVu Sans Mono", monospace', fontSize: 14, lineHeight: 1,
  cursorStyle: "block", cursorBlink: true, scrollback: 1000, theme: "design",
  editorFontSize: 14, editorWrap: false, editorTabSize: 4,
  updateCheckOnStart: false,
  language: "system",
};
const storageKey = "werkterm.settings";
export function normalizeSettings(input: unknown): Settings {
  const v = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const result = { ...defaultSettings, pasteRemember: normalizePasteRemember(v.pasteRemember) };
  if (input && typeof input === "object" && !Array.isArray(input)) {
    result.iconSet = typeof v.iconSet === "string" && v.iconSet.trim() ? v.iconSet.slice(0,64) : "Standard";
    result.design = typeof v.design === "string" ? v.design.slice(0,60) : "Werkterm Dunkel";
    if (!("theme" in v)) result.theme = "Werkterm Dunkel";
  }
  for (const key of ["tuxEnabled", "copyOnSelect", "logAllSessions", "logStripAnsi", "confirmCloseSsh", "followTerminalFolder", "shellIntegration", "sshPromptCommand", "monitoring", "cursorBlink", "editorWrap", "compact", "sidebarVisible", "sidebarRight", "tabNumbers", "tabClose", "updateCheckOnStart"] as const) if (typeof v[key] === "boolean") result[key] = v[key];
  for (const [key, min, max] of [["tuxIdleMinutes", 1, 120], ["tuxCount", 1, 8], ["fontSize", 8, 32], ["editorFontSize", 8, 32], ["lineHeight", 1, 2], ["scrollback", 1000, 100000]] as const) {
    const value = v[key]; if (typeof value === "number" && Number.isFinite(value)) result[key] = Math.max(min, Math.min(max, key === "lineHeight" ? value : Math.round(value)));
  }
  if (v.rightClick === "menu" || v.rightClick === "paste") result.rightClick = v.rightClick;
  if (typeof v.logFolder === "string") result.logFolder = v.logFolder;
  if (v.language === "system" || v.language === "de" || v.language === "en") result.language = v.language;
  if (v.pasteConfirm === "always" || v.pasteConfirm === "never" || v.pasteConfirm === "multiline") result.pasteConfirm = v.pasteConfirm;
  if (v.splitMode === "single" || v.splitMode === "columns" || v.splitMode === "rows" || v.splitMode === "quad") result.splitMode = v.splitMode;
  if (v.bars === "menu" || v.bars === "toolbar" || v.bars === "both") result.bars = v.bars;
  if (v.toolbarSize === "small" || v.toolbarSize === "standard" || v.toolbarSize === "labels") result.toolbarSize = v.toolbarSize;
  if (typeof v.fontFamily === "string" && v.fontFamily.trim()) result.fontFamily = v.fontFamily.slice(0, 500);
  if (v.cursorStyle === "block" || v.cursorStyle === "bar" || v.cursorStyle === "underline") result.cursorStyle = v.cursorStyle;
  if (v.editorTabSize === 2 || v.editorTabSize === 4 || v.editorTabSize === 8) result.editorTabSize = v.editorTabSize;
  if (v.importedTheme && typeof v.importedTheme === "object") {
    const colors = v.importedTheme as Record<string, unknown>;
    const base = terminalThemes["Werkterm Dunkel"];
    result.importedTheme = { ...base };
    for (const key of [...ansiKeys, "background", "foreground", "cursor", "selectionBackground"] as const) if (typeof colors[key] === "string" && /^#[0-9a-f]{6}$/i.test(colors[key])) result.importedTheme[key] = colors[key];
  }
  if (typeof v.theme === "string" && (v.theme === "design" || Object.prototype.hasOwnProperty.call(terminalThemes, v.theme) || (v.theme === importedThemeId && result.importedTheme))) result.theme = v.theme;
  return result;
}
export function selectedTheme(settings: Settings): TerminalTheme { return settings.theme === "design" ? getDesign(settings.design).terminal : settings.theme === importedThemeId && settings.importedTheme ? settings.importedTheme : terminalThemes[settings.theme] ?? terminalThemes["Werkterm Dunkel"]; }
/** Raw localStorage text (current key, then the legacy key). Only a cache: settings.json is the source of truth. */
export function cachedSettingsText(): string | null {
  try { return localStorage.getItem(storageKey) ?? localStorage.getItem("linmoba.settings"); } catch { return null; }
}
/** Synchronous cache read for the very first render (no design flicker). */
export function loadSettings(): Settings {
  try { return normalizeSettings(JSON.parse(cachedSettingsText() ?? "null")); } catch { return { ...defaultSettings }; }
}
/** Writes the localStorage cache only; the file write is done by SettingsSync. */
export function saveSettings(settings: Settings): void { try { localStorage.setItem(storageKey, JSON.stringify(normalizeSettings(settings))); } catch { /* Session settings remain usable. */ } }
/** Settings that describe this device (local paths). They live in localStorage only, never in settings.json. */
export const localOnlyKeys = ["logFolder", "language"] as const;
const isLocalKey = (key: string): boolean => (localOnlyKeys as readonly string[]).includes(key);
/** JSON text of the shared settings file: normalized, without device-local keys. */
export function serializeSettings(settings: Settings): string {
  const shared: Record<string, unknown> = { ...normalizeSettings(settings) };
  for (const key of localOnlyKeys) delete shared[key];
  return JSON.stringify(shared, null, 2);
}
const localValues = (cacheText: string | null): Pick<Settings, typeof localOnlyKeys[number]> => {
  try { const { logFolder, language } = normalizeSettings(JSON.parse(cacheText ?? "null")); return { logFolder, language }; } catch { return { logFolder: defaultSettings.logFolder, language: defaultSettings.language }; }
};

const isPlainObject = (value: unknown): boolean => !!value && typeof value === "object" && !Array.isArray(value);
export type LoadOutcome = { ok: true; settings: Settings; migrated: boolean } | { ok: false; error: string };
/**
 * Merges the settings file with the localStorage cache.
 * File present: it wins (except device-local keys, which come from the cache); an unreadable file is an error
 * (never overwritten with defaults).
 * File absent: only with `allowMigrate` the cache values are adopted once (`migrated`, to be written to the file);
 * otherwise defaults apply and nothing is migrated.
 */
export function interpretLoaded(fileText: string | null, cacheText: string | null, allowMigrate = true): LoadOutcome {
  const local = localValues(cacheText);
  if (fileText !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(fileText); } catch { return { ok: false, error: t("settings.error.invalidJson") }; }
    if (!isPlainObject(parsed)) return { ok: false, error: t("settings.error.notObject") };
    return { ok: true, settings: { ...normalizeSettings(parsed), ...local }, migrated: false };
  }
  if (cacheText === null || !allowMigrate) return { ok: true, settings: { ...normalizeSettings(null), ...local }, migrated: false };
  try {
    const parsed: unknown = JSON.parse(cacheText);
    return { ok: true, settings: normalizeSettings(parsed), migrated: isPlainObject(parsed) };
  } catch { return { ok: true, settings: normalizeSettings(null), migrated: false }; }
}

/**
 * Three-way merge after a write conflict: keys the user changed here (mine vs. base, top level; pasteRemember
 * per session entry) win, everything else is taken from the file as it is now (theirs). Without a known base
 * every key that differs from theirs counts as changed here.
 */
export function mergeSettings(base: Settings | null, mine: Settings, theirs: Settings): Settings {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const reference = (base ?? theirs) as unknown as Record<string, unknown>;
  const own = mine as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = { ...theirs };
  for (const key of new Set([...Object.keys(own), ...Object.keys(reference)])) {
    if (key === "pasteRemember") continue;
    if (isLocalKey(key)) { result[key] = own[key]; continue; }
    if (same(own[key], reference[key])) continue;
    if (own[key] === undefined) delete result[key]; else result[key] = own[key];
  }
  const before = (base ?? theirs).pasteRemember;
  const global = same(mine.pasteRemember.global, before.global) ? theirs.pasteRemember.global : mine.pasteRemember.global;
  const sessions = { ...theirs.pasteRemember.sessions };
  for (const id of new Set([...Object.keys(mine.pasteRemember.sessions), ...Object.keys(before.sessions)])) {
    const mineEntry = mine.pasteRemember.sessions[id];
    if (same(mineEntry, before.sessions[id])) continue;
    if (mineEntry === undefined) delete sessions[id]; else sessions[id] = mineEntry;
  }
  result.pasteRemember = { global, sessions };
  return { ...normalizeSettings(result), logFolder: mine.logFolder, language: mine.language };
}
