import type { ITheme } from "@xterm/xterm";
import { t, type TextKey } from "../i18n";
export const ansiKeys = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
export type TerminalTheme = ITheme & Record<typeof ansiKeys[number] | "background" | "foreground" | "cursor", string>;
function theme(background: string, foreground: string, colors: string[]): TerminalTheme {
  return { background, foreground, cursor: foreground, selectionBackground: background === "#ffffff" ? "#b4d5ff" : "#ffffff40", ...Object.fromEntries(ansiKeys.map((key, i) => [key, colors[i]])) } as TerminalTheme;
}
export const terminalThemes: Record<string, TerminalTheme> = {
  "Werkterm Dunkel": { ...theme("#000000", "#c5c8c6", ["#000000", "#cd3131", "#1e9d38", "#e3961a", "#1769ff", "#c5178a", "#19a679", "#c5c8c6", "#5f5f5f", "#f44747", "#6a9955", "#f38518", "#729fcf", "#c33882", "#29b8db", "#ffffff"]), cursor: "#1769ff", selectionBackground: "#3c3c3c" },
  "Solarized Dark": theme("#002b36", "#839496", ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]),
  "Gruvbox Dark": theme("#282828", "#ebdbb2", ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]),
  "Hell": theme("#ffffff", "#202020", ["#202020", "#a31515", "#176b28", "#795e00", "#174ea6", "#811f8c", "#006b70", "#b0b0b0", "#666666", "#c02020", "#247a32", "#8a6500", "#225bbb", "#942da0", "#007b80", "#eeeeee"]),
};
/** Persisted id of the theme created by the MobaXterm colour import. */
export const importedThemeId = "MobaXterm (importiert)";
const themeLabels: Record<string, TextKey> = { "Werkterm Dunkel": "theme.werktermDark", "Hell": "theme.light", [importedThemeId]: "theme.imported" };
/** Display name of a theme id: built-in names are translated, everything else (e.g. "Solarized Dark") is shown as is. */
export function themeLabel(id: string): string {
  return Object.prototype.hasOwnProperty.call(themeLabels, id) ? t(themeLabels[id]) : id;
}
export const emojiFallback = ', "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "Twemoji Mozilla"';
