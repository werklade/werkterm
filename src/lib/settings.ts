import { ansiKeys, terminalThemes, type TerminalTheme } from "./terminalThemes";
export interface Settings {
  tuxEnabled: boolean; tuxIdleMinutes: number;
  logFolder: string; logAllSessions: boolean; logStripAnsi: boolean; pasteConfirm: import("./paste").PasteConfirm;
  copyOnSelect: boolean; rightClick: "menu" | "paste";
  confirmCloseSsh: boolean;
  splitMode: "single" | "columns" | "rows" | "quad";
  bars: "menu" | "toolbar" | "both"; toolbarSize: "small" | "standard" | "labels";
  compact: boolean; sidebarVisible: boolean; sidebarRight: boolean; tabNumbers: boolean; tabClose: boolean;
  followTerminalFolder: boolean; shellIntegration: boolean; sshPromptCommand: boolean; monitoring: boolean;
  fontFamily: string; fontSize: number; lineHeight: number; cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean; scrollback: number; theme: string; importedTheme?: TerminalTheme;
  editorFontSize: number; editorWrap: boolean; editorTabSize: 2 | 4 | 8;
}
export const defaultSettings: Settings = {
  tuxEnabled: true, tuxIdleMinutes: 10,
  logFolder: "", logAllSessions: false, logStripAnsi: true, pasteConfirm: "multiline",
  copyOnSelect: true, rightClick: "menu",
  confirmCloseSsh: true,
  splitMode: "single",
  bars: "both", toolbarSize: "labels", compact: false, sidebarVisible: true, sidebarRight: false, tabNumbers: false, tabClose: true,
  followTerminalFolder: true, shellIntegration: true, sshPromptCommand: true, monitoring: true,
  fontFamily: '"Cascadia Mono", "DejaVu Sans Mono", monospace', fontSize: 14, lineHeight: 1,
  cursorStyle: "block", cursorBlink: true, scrollback: 1000, theme: "Werkterm Dunkel",
  editorFontSize: 14, editorWrap: false, editorTabSize: 4,
};
const storageKey = "werkterm.settings";
export function normalizeSettings(input: unknown): Settings {
  const v = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const result = { ...defaultSettings };
  for (const key of ["tuxEnabled", "copyOnSelect", "logAllSessions", "logStripAnsi", "confirmCloseSsh", "followTerminalFolder", "shellIntegration", "sshPromptCommand", "monitoring", "cursorBlink", "editorWrap", "compact", "sidebarVisible", "sidebarRight", "tabNumbers", "tabClose"] as const) if (typeof v[key] === "boolean") result[key] = v[key];
  for (const [key, min, max] of [["tuxIdleMinutes", 1, 120], ["fontSize", 8, 32], ["editorFontSize", 8, 32], ["lineHeight", 1, 2], ["scrollback", 1000, 100000]] as const) {
    const value = v[key]; if (typeof value === "number" && Number.isFinite(value)) result[key] = Math.max(min, Math.min(max, key === "lineHeight" ? value : Math.round(value)));
  }
  if (v.rightClick === "menu" || v.rightClick === "paste") result.rightClick = v.rightClick;
  if (typeof v.logFolder === "string") result.logFolder = v.logFolder;
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
  if (typeof v.theme === "string" && (Object.prototype.hasOwnProperty.call(terminalThemes, v.theme) || (v.theme === "MobaXterm (importiert)" && result.importedTheme))) result.theme = v.theme;
  return result;
}
export function selectedTheme(settings: Settings): TerminalTheme { return settings.theme === "MobaXterm (importiert)" && settings.importedTheme ? settings.importedTheme : terminalThemes[settings.theme] ?? terminalThemes["Werkterm Dunkel"]; }
export function loadSettings(): Settings {
  try { return normalizeSettings(JSON.parse(localStorage.getItem(storageKey) ?? localStorage.getItem("linmoba.settings") ?? "null")); } catch { return { ...defaultSettings }; }
}
export function saveSettings(settings: Settings): void { try { localStorage.setItem(storageKey, JSON.stringify(normalizeSettings(settings))); } catch { /* Session settings remain usable. */ } }
