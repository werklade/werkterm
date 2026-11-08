import { ansiKeys, terminalThemes, type TerminalTheme } from "./terminalThemes";
import { luminance, mixColor, parseColor } from "./colorCodes";
export const uiTokens = ["bg-content", "bg-app", "bg-panel", "bg-panel-alt", "bg-toolbar", "bg-menubar", "bg-input", "bg-hover", "bg-active", "bg-tab", "bg-tab-active", "fg-primary", "fg-secondary", "fg-muted", "fg-inverse", "accent", "accent-hover", "border", "border-strong", "focus-ring", "danger", "warning", "success", "on-accent", "monitor-ok", "monitor-warn", "monitor-critical", "selection", "backdrop", "shadow", "warning-bg", "error-bg", "indent-guide", "diff-added", "diff-deleted", "diff-added-text", "diff-deleted-text"] as const;
export const editorTokens = ["keyword", "string", "comment", "number", "function", "type", "variable", "property", "operator", "tag", "attribute", "meta", "invalid", "gutter-fg", "active-line", "selection", "cursor"] as const;
export type UiToken = typeof uiTokens[number];
export type EditorToken = typeof editorTokens[number];
export interface Design {
    name: string;
    ui: Record<UiToken, string>;
    terminal: TerminalTheme;
    editor: Record<EditorToken, string>;
}
export interface StoredDesign {
    id: string;
    design: Design;
}
const baseUi: Record<UiToken, string> = {
    "bg-content": "#000000",
    "bg-app": "#1e1e1e",
    "bg-panel": "#252526",
    "bg-panel-alt": "#2d2d2e",
    "bg-toolbar": "#333333",
    "bg-menubar": "#444444",
    "bg-input": "#2a2a2a",
    "bg-hover": "#3c3c3c",
    "bg-active": "#4b4b4b",
    "bg-tab": "#333333",
    "bg-tab-active": "#5e5e5e",
    "fg-primary": "#d4d4d4",
    "fg-secondary": "#a9b7c6",
    "fg-muted": "#7a7a7a",
    "fg-inverse": "#1e1e1e",
    "accent": "#1769ff",
    "accent-hover": "#3d84ff",
    "border": "#2a2a2a",
    "border-strong": "#3c3c3c",
    "focus-ring": "#1769ff",
    "danger": "#f44747",
    "warning": "#e3961a",
    "success": "#00b452",
    "on-accent": "#ffffff",
    "monitor-ok": "#00b452",
    "monitor-warn": "#e3961a",
    "monitor-critical": "#f44747",
    "selection": "#3c3c3c",
    "backdrop": "#00000099",
    "shadow": "#00000088",
    "warning-bg": "#e3961a20",
    "error-bg": "#591c1c",
    "indent-guide": "#7a7a7a40",
    "diff-added": "#254e37",
    "diff-deleted": "#602c36",
    "diff-added-text": "#35724b",
    "diff-deleted-text": "#8a3d4b"
};
const makeEditor = (values: string[]) => Object.fromEntries(editorTokens.map((key, i) => [key, values[i]])) as Record<EditorToken, string>;
const oldEditor = makeEditor(["#c678dd", "#98c379", "#829b7a", "#d19a66", "#61afef", "#e5c07b", "#abb2bf", "#e06c75", "#56b6c2", "#e06c75", "#d19a66", "#c678dd", "#ffffff", "#999999", "#ffffff0b", "#3c3c3c", "#1769ff"]);
function branded(name: string, ui: Record<UiToken, string>, terminal: string[], editor: string[], light = false): Design {
    return { name, ui: { ...baseUi, ...ui, "warning-bg": light ? "#b7791f20" : "#f0b42920", "error-bg": light ? "#c6282820" : "#e5534b20", "indent-guide": light ? "#616e7c40" : "#7b879440", "diff-added": light ? "#d9f4df" : "#254e37", "diff-deleted": light ? "#ffe0e0" : "#602c36", "diff-added-text": light ? "#a4e4b3" : "#35724b", "diff-deleted-text": light ? "#ffb9b9" : "#8a3d4b" }, terminal: { background: terminal[0], foreground: terminal[1], cursor: terminal[2], selectionBackground: terminal[3], ...Object.fromEntries(ansiKeys.map((k, i) => [k, terminal[i + 4]])) } as TerminalTheme, editor: makeEditor(editor) };
}
export const builtInDesigns: Record<string, Design> = {
    "Werkterm Dunkel": { name: "Werkterm Dunkel", ui: baseUi, terminal: { ...terminalThemes["Werkterm Dunkel"] }, editor: oldEditor },
    "Werklade Dunkel": branded("Werklade Dunkel", { ...baseUi, "bg-content": "#141b22", "bg-app": "#1f2933", "bg-panel": "#26313d", "bg-panel-alt": "#2c3946", "bg-toolbar": "#18212a", "bg-menubar": "#141b22", "bg-input": "#1a232c", "bg-hover": "#33414f", "bg-active": "#3d4d5d", "bg-tab": "#222c36", "bg-tab-active": "#33414f", "fg-primary": "#e4e7eb", "fg-secondary": "#b8c0c9", "fg-muted": "#7b8794", "fg-inverse": "#1f2933", "accent": "#f08a24", "accent-hover": "#f5a04a", "on-accent": "#1f2933", "border": "#2f3b48", "border-strong": "#3e4c59", "focus-ring": "#f08a24", "danger": "#e5534b", "warning": "#f0b429", "success": "#7bc96f", "selection": "#3d4d5d", "monitor-ok": "#7bc96f", "monitor-warn": "#f0b429", "monitor-critical": "#e5534b" }, "#141b22 #e4e7eb #f08a24 #3d4d5d #141b22 #e5534b #7bc96f #f0b429 #5aa9e6 #c08adf #4fc1c5 #cbd2d9 #616e7c #ff7b72 #9be39a #ffd166 #8cc4f0 #d9a7ef #7fdfe0 #ffffff".split(" "), "#f08a24 #9be39a #7b8794 #ffd166 #8cc4f0 #4fc1c5 #e4e7eb #b8c0c9 #cbd2d9 #f5a04a #ffd166 #c08adf #ff7b72 #616e7c #ffffff0b #3d4d5d #f08a24".split(" ")),
    "Werklade Hell": branded("Werklade Hell", { ...baseUi, "bg-content": "#ffffff", "bg-app": "#f4f5f7", "bg-panel": "#f4f5f7", "bg-panel-alt": "#e9ecef", "bg-toolbar": "#e4e7eb", "bg-menubar": "#e4e7eb", "bg-input": "#ffffff", "bg-hover": "#dde2e7", "bg-active": "#cbd2d9", "bg-tab": "#e4e7eb", "bg-tab-active": "#ffffff", "fg-primary": "#1f2933", "fg-secondary": "#3e4c59", "fg-muted": "#616e7c", "fg-inverse": "#ffffff", "accent": "#d9731a", "accent-hover": "#b35d10", "on-accent": "#ffffff", "border": "#d5dbe1", "border-strong": "#cbd2d9", "focus-ring": "#d9731a", "danger": "#c62828", "warning": "#b7791f", "success": "#2f8a3a", "selection": "#fde8d2", "monitor-ok": "#2f8a3a", "monitor-warn": "#b7791f", "monitor-critical": "#c62828" }, "#ffffff #1f2933 #d9731a #fde8d2 #1f2933 #c62828 #2f8a3a #9a6700 #1f6fb2 #8e44ad #0f7b7b #9aa5b1 #616e7c #e5534b #3fa34d #b7791f #2f80c9 #a35bc6 #159a9a #3e4c59".split(" "), "#b35d10 #2f8a3a #7b8794 #9a6700 #1f6fb2 #0f7b7b #1f2933 #3e4c59 #3e4c59 #b35d10 #9a6700 #8e44ad #c62828 #9aa5b1 #0000000b #fde8d2 #d9731a".split(" "), true),
};
const colorPattern = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
export function normalizeDesign(input: unknown, fallback: Design = builtInDesigns["Werklade Dunkel"]): Design {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  function group<T extends string>(input: unknown, base: Record<T, string>): Record<T, string> {
    const colors = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return Object.fromEntries(Object.keys(base).map(key => [key,
      typeof colors[key] === "string" && colorPattern.test(colors[key]) ? colors[key] : base[key as T],
    ])) as Record<T, string>;
  }
  const terminalFallback = Object.fromEntries([...ansiKeys, "background", "foreground", "cursor", "selectionBackground"]
    .map(key => [key, fallback.terminal[key as keyof TerminalTheme] as string]));
  return {
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 60) : fallback.name,
    ui: group(value.ui, fallback.ui), terminal: group(value.terminal, terminalFallback) as TerminalTheme,
    editor: group(value.editor, fallback.editor),
  };
}
const users = new Map<string, Design>();
export const designsChangedEvent = "werkterm-designs-changed";
function changed() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(designsChangedEvent));
}
export function registerUserDesign(id: string, design: Design) { users.set(id, normalizeDesign(design)); changed(); }
export function unregisterUserDesign(id: string) { users.delete(id); changed(); }
export function getUserDesigns(): StoredDesign[] { return [...users].map(([id, design]) => ({ id, design })); }
export function getDesign(name: string): Design {
  return (Object.prototype.hasOwnProperty.call(builtInDesigns, name) ? builtInDesigns[name] : undefined)
    ?? [...users.values()].find(design => design.name === name) ?? builtInDesigns["Werklade Dunkel"];
}
export function designColorScheme(design: Design): "light" | "dark" {
  return luminance(parseColor(design.ui["bg-app"])!) > 140 ? "light" : "dark";
}
export function applyDesign(design: Design) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(design.ui)) root.style.setProperty(`--${key}`, value);
  for (const [key, value] of Object.entries(design.editor)) root.style.setProperty(`--editor-${key}`, value);
  for (const [key, value] of Object.entries(design.terminal)) {
    const name = ({ background: "bg", foreground: "fg", selectionBackground: "selection" } as Record<string, string>)[key]
      ?? key.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`);
    root.style.setProperty(`--term-${name}`, value as string);
  }
  root.style.colorScheme = designColorScheme(design);
}
export function contrastRatio(foreground: string, background: string): number {
  const bg = parseColor(background)!;
  const fg = mixColor(parseColor(foreground)!, bg);
  function relative(color: { r: number; g: number; b: number }): number {
    return [color.r, color.g, color.b].map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  }
  const a = relative(fg), b = relative(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
