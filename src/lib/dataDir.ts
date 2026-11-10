import { invoke } from "@tauri-apps/api/core";

export interface DataDirStatus { configured: boolean; custom: boolean; path: string; defaultPath: string; reachable: boolean }
export interface DataDirInspect { exists: boolean; isDir: boolean; writable: boolean; hasData: boolean; sameAsCurrent: boolean }
export interface FileFingerprint { name: string; modifiedMs: number; size: number }

export const dataDirStatus = () => invoke<DataDirStatus>("data_dir_status");
export const dataDirInspect = (path: string) => invoke<DataDirInspect>("data_dir_inspect", { path });
/** `path === null` selects the default folder. */
export const dataDirSet = (path: string | null, copyCurrent: boolean) => invoke<DataDirStatus>("data_dir_set", { path, copyCurrent });
export const dataDirFingerprint = () => invoke<FileFingerprint[]>("data_dir_fingerprint");
export const appRestart = () => invoke<void>("app_restart");
/** Backs up and removes the pointer file; returns the (then unconfigured) status. */
export const dataDirResetPointer = () => invoke<DataDirStatus>("data_dir_reset_pointer");

/** Modification stamp of settings.json as reported by the backend. */
export interface FileStamp { modifiedMs: number; size: number }
export interface LoadedSettingsFile extends FileStamp { json: string }
/** Rejection value of settings_save when the file changed since `base`. */
export const settingsConflict = "SETTINGS_CONFLICT";
export const isSettingsConflict = (reason: unknown): boolean =>
  reason === settingsConflict || (reason instanceof Error && reason.message === settingsConflict);
export const settingsLoadRaw = () => invoke<LoadedSettingsFile | null>("settings_load");
/** `base === null` means "no file is expected yet". */
export const settingsSaveRaw = (json: string, base: FileStamp | null) => invoke<FileStamp>("settings_save", { json, base });

/** A folder the user may pick: the default folder (sent as null) or an explicit path. */
export type DataDirChoice = { kind: "default"; path: string } | { kind: "folder"; path: string };
export const choicePath = (choice: DataDirChoice): string | null => choice.kind === "default" ? null : choice.path;

export interface ChoiceFeedback { tone: "info" | "error"; message: string; canConfirm: boolean; showCopy: boolean }

/** Translates the backend inspection of a chosen folder into dialog feedback. */
export function describeInspect(info: DataDirInspect, options: { allowSame: boolean }): ChoiceFeedback {
  if (info.exists && !info.isDir) return { tone: "error", message: "Der Pfad ist kein Ordner.", canConfirm: false, showCopy: false };
  if (!info.writable) return { tone: "error", message: "Der Ordner ist nicht beschreibbar.", canConfirm: false, showCopy: false };
  if (info.sameAsCurrent && !options.allowSame) return { tone: "info", message: "Dieser Ordner wird bereits verwendet.", canConfirm: false, showCopy: false };
  if (info.hasData) return { tone: "info", message: "Vorhandene Werkterm-Daten gefunden. Sie werden verwendet.", canConfirm: true, showCopy: false };
  return { tone: "info", message: "Der Ordner enthält noch keine Werkterm-Daten.", canConfirm: true, showCopy: true };
}

export const fingerprintMinGapMs = 5000;
/** Throttle for fingerprint checks triggered by window focus. */
export function shouldCheck(now: number, last: number, minGap = fingerprintMinGapMs): boolean {
  return now - last >= minGap;
}

/** Names whose size or modification time differ. The first sample (prev === null) is only a baseline. */
export function changedFiles(prev: readonly FileFingerprint[] | null, next: readonly FileFingerprint[]): string[] {
  if (!prev) return [];
  const before = new Map(prev.map(entry => [entry.name, entry]));
  const after = new Map(next.map(entry => [entry.name, entry]));
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter(name => {
    const a = before.get(name);
    const b = after.get(name);
    if (!a || !b) return true;
    return a.modifiedMs !== b.modifiedMs || a.size !== b.size;
  });
}

/** Takes one entry from `fresh` into `baseline`, so an own write is not mistaken for an external one. */
export function mergeEntry(baseline: readonly FileFingerprint[] | null, fresh: readonly FileFingerprint[], name: string): FileFingerprint[] | null {
  if (!baseline) return null;
  const entry = fresh.find(item => item.name === name);
  const rest = baseline.filter(item => item.name !== name);
  return entry ? [...rest, entry] : rest;
}

export interface ReloadPlan { reload: string[]; baseline: FileFingerprint[] }
/**
 * Decides what to reload. While an own settings write is outstanding, an external settings.json change is
 * neither reloaded nor absorbed into the baseline: the own write wins, and the baseline is updated after it.
 */
export function planReload(prev: readonly FileFingerprint[] | null, next: readonly FileFingerprint[], settingsPending: boolean): ReloadPlan {
  const changed = changedFiles(prev, next);
  if (!settingsPending || !changed.includes("settings.json")) return { reload: changed, baseline: [...next] };
  const old = prev?.find(entry => entry.name === "settings.json");
  const rest = next.filter(entry => entry.name !== "settings.json");
  return { reload: changed.filter(name => name !== "settings.json"), baseline: old ? [...rest, old] : rest };
}
