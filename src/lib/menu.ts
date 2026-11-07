export interface ShortcutEvent { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }
export const shortcuts = [
  { action: "multiexec", label: "MultiExec", shortcut: "Strg+Umschalt+M" },
  { action: "local", label: "Neues lokales Terminal", shortcut: "Strg+Umschalt+T" },
  { action: "close", label: "Tab schließen", shortcut: "Strg+Umschalt+W" },
  { action: "larger", label: "Schrift größer", shortcut: "Strg+Umschalt+Plus" },
  { action: "smaller", label: "Schrift kleiner", shortcut: "Strg+Umschalt+Minus" },
  { action: "resetFont", label: "Standardschriftgröße", shortcut: "Strg+Umschalt+0" },
  { action: "fullscreen", label: "Vollbild", shortcut: "F11" },
  { action: "settings", label: "Einstellungen", shortcut: "Strg+, (außer im Terminal)" },
] as const;
export function shortcutAction(e: ShortcutEvent, terminal: boolean): string | null {
  if (e.altKey || e.metaKey) return null;
  if (e.key === "F11" && !e.ctrlKey && !e.shiftKey) return "fullscreen";
  if (!e.ctrlKey) return null;
  if (!e.shiftKey) return e.key === "," && !terminal ? "settings" : null;
  if (e.key.toLowerCase() === "m") return "multiexec";
  if (e.key.toLowerCase() === "t") return "local";
  if (e.key.toLowerCase() === "w") return "close";
  if (e.key === "+" || e.code === "NumpadAdd") return "larger";
  if (e.key === "_" || e.key === "-" || e.code === "NumpadSubtract") return "smaller";
  if (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0") return "resetFont";
  return null;
}
export function menuMove(index: number, key: string, disabled: boolean[]): number {
  const n = disabled.length;
  if (!n || disabled.every(Boolean)) return -1;
  const step = key === "ArrowUp" || key === "ArrowLeft" || key === "End" ? -1 : 1;
  let next = key === "Home" ? -1 : key === "End" ? 0 : index;
  for (let i = 0; i < n; i++) { next = (next + step + n) % n; if (!disabled[next]) return next; }
  return -1;
}

export function allowMenuMnemonic(e: ShortcutEvent, terminalOrEditor: boolean): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && !terminalOrEditor;
}
export const toolsMenuItems = (multiExec: boolean) => [
  { label: "MultiExec", action: "multiexec", shortcut: "Strg+Umschalt+M", checked: multiExec },
  { label: "Einstellungen…", action: "settings", shortcut: "Strg+," },
  { label: "", action: "separator", separator: true },
  { label: "Tunnel-Manager", action: "tunnels", disabled: true, tooltip: "folgt" },
  { label: "Jump host", action: "jump", disabled: true, tooltip: "folgt" },
];
