import { t } from "../i18n";

/** Display text of a shortcut in the current language, e.g. ["ctrl", "shift", "T"] -> "Strg+Umschalt+T" / "Ctrl+Shift+T". */
export function formatShortcut(parts: readonly string[]): string {
  return parts.map(part => part === "ctrl" ? t("key.ctrl") : part === "shift" ? t("key.shift") : part).join("+");
}
