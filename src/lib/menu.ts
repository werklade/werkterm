import { t } from "../i18n";
import { formatShortcut } from "./formatShortcut";
export interface ShortcutEvent { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }
/** Shortcut list of the help dialog, in the current language (labels and key names are translated). */
export function shortcutList(): { action: string; label: string; shortcut: string }[] {
  const ctrlShift = (key: string) => formatShortcut(["ctrl", "shift", key]);
  return [
    { action: "multiexec", label: t("menu.tools.multiexec"), shortcut: ctrlShift("M") },
    { action: "local", label: t("tab.newLocal"), shortcut: ctrlShift("T") },
    { action: "close", label: t("menu.terminal.close"), shortcut: ctrlShift("W") },
    { action: "larger", label: t("menu.view.fontLarger"), shortcut: ctrlShift("Plus") },
    { action: "smaller", label: t("menu.view.fontSmaller"), shortcut: ctrlShift("Minus") },
    { action: "resetFont", label: t("shortcut.resetFont"), shortcut: ctrlShift("0") },
    { action: "fullscreen", label: t("menu.view.fullscreen"), shortcut: "F11" },
    { action: "settings", label: t("menu.settings"), shortcut: `${formatShortcut(["ctrl", ","])} ${t("shortcut.exceptTerminal")}` },
  ];
}
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

export function allowMenuMnemonic(e: ShortcutEvent & { getModifierState?(key: string): boolean }, terminalOrEditor: boolean): boolean {
  return !e.getModifierState?.("AltGraph") && e.altKey && !e.ctrlKey && !e.metaKey && !terminalOrEditor;
}

export function shouldFocusMenu(e: Pick<ShortcutEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey"> & { getModifierState?(key: string): boolean }, terminalOrEditor: boolean): boolean {
  if (e.getModifierState?.("AltGraph") || (e.ctrlKey && e.altKey)) return false;
  if (e.key === "F10") return !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
  return e.key === "Alt" && !terminalOrEditor && !e.ctrlKey && !e.metaKey;
}
