import { invoke } from "@tauri-apps/api/core";
import { documentDir, homeDir, join } from "@tauri-apps/api/path";
import type { Settings } from "./settings";
/** Documents folder when the system defines one (not on minimal Linux without XDG user dirs), else the home folder. */
export const defaultLogFolder = async () => join(await documentDir().catch(() => homeDir()), "Werkterm-Logs");
export function localTimestamp(date = new Date()): string {
  const n = (v: number) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${n(date.getMonth() + 1)}-${n(date.getDate())}_${n(date.getHours())}-${n(date.getMinutes())}-${n(date.getSeconds())}`;
}
export const startLog = (id: number, name: string, settings: Settings) => invoke<string>("session_log_start", { id, name, timestamp: localTimestamp(), folder: settings.logFolder || null, strip: settings.logStripAnsi });
export const stopLog = (id: number) => invoke<void>("session_log_stop", { id });
export const openLogFolder = (folder: string) => invoke<void>("session_log_open_folder", { folder: folder || null });
export const terminalPasteRequests = new Map<number, () => void>();
