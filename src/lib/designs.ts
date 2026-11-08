import { ansiKeys, terminalThemes, type TerminalTheme } from "./terminalThemes";
import { luminance, mixColor, parseColor } from "./colorCodes";
import werkladeTokens from "../brand/werklade.tokens.json";
export const uiTokens = ["bg-content", "bg-app", "bg-panel", "bg-panel-alt", "bg-toolbar", "bg-menubar", "bg-input", "bg-hover", "bg-active", "bg-tab", "bg-tab-active", "fg-primary", "fg-secondary", "fg-muted", "fg-inverse", "accent", "accent-hover", "accent-hover-fill", "border", "border-strong", "focus-ring", "danger", "warning", "success", "on-accent", "monitor-ok", "monitor-warn", "monitor-critical", "selection", "backdrop", "shadow", "warning-bg", "error-bg", "indent-guide", "diff-added", "diff-deleted", "diff-added-text", "diff-deleted-text"] as const;
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
    "accent-hover-fill": "#3d84ff",
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
// Werklade designs come from the werklade/design tokens (copy in src/brand, update via npm run sync-design).
function fromTokens(id: keyof typeof werkladeTokens.themes): Design {
    const theme = werkladeTokens.themes[id];
    return { name: theme.name, ui: { ...baseUi, ...theme.ui }, terminal: { ...theme.terminal } as TerminalTheme, editor: { ...theme.editor } as Record<EditorToken, string> };
}
export const builtInDesigns: Record<string, Design> = {
    "Werkterm Dunkel": { name: "Werkterm Dunkel", ui: baseUi, terminal: { ...terminalThemes["Werkterm Dunkel"] }, editor: oldEditor },
    "Werklade Dunkel": fromTokens("dark"),
    "Werklade Hell": fromTokens("light"),
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
  const ui = group(value.ui, fallback.ui);
  // Designs saved before accent-hover-fill existed keep their own hover colour for the button fill.
  const storedUi = value.ui && typeof value.ui === "object" ? value.ui as Record<string, unknown> : {};
  const valid = (key: string) => typeof storedUi[key] === "string" && colorPattern.test(storedUi[key] as string);
  if (valid("accent-hover") && !valid("accent-hover-fill")) ui["accent-hover-fill"] = ui["accent-hover"];
  return {
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 60) : fallback.name,
    ui, terminal: group(value.terminal, terminalFallback) as TerminalTheme,
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
