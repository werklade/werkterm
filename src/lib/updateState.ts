import { formatSize } from "./formatSize";

// Pure logic of the update check: no network, no Tauri. The invoke layer lives in update.ts.

export type InstallKind = "appimage" | "deb" | "rpm" | "nsis" | "msi" | "other";
export interface UpdateInfo {
  currentVersion: string; installKind: InstallKind; selfUpdate: boolean; channel: "stable" | "test"; configured: boolean;
  /** false although selfUpdate: the install cannot run here (e.g. AppImage folder not writable); blockedReason says why. */
  canInstall: boolean; blockedReason: string | null;
}
/** Raw answer of update_check; every text field comes from the server and is untrusted. */
export interface UpdateCheck { available: boolean; version: string | null; notes: string | null; pubDate: string | null }
export interface UpdateProgress { downloaded: number; total: number | null }
/** An update announcement after sanitizing; safe to render as plain text. */
export interface AvailableUpdate { version: string; notes: string; notesTruncated: boolean; pubDate: string | null }

export const updateDownloadUrl = "https://pkg.werklade.de/werkterm/";
export const aptCommand = "sudo apt update && sudo apt install --only-upgrade werkterm";
export const aptRepoNote = "Funktioniert nur, wenn das Werklade-Repository eingebunden ist.";
export const blockedFallback = "Diese Installation lässt sich nicht automatisch aktualisieren.";
/** Exact error string of update_install: the process was shut down but the installer did not start. */
export const restartRequiredCode = "UPDATE_RESTART_REQUIRED";
export const restartRequiredMessage = "Das Update wurde nicht installiert. Werkterm muss neu gestartet werden.";
export const isRestartRequired = (reason: unknown): boolean => (reason instanceof Error ? reason.message : reason) === restartRequiredCode;
export const transfersMessage = (count: number): string =>
  count === 1 ? "Eine Übertragung läuft und wird abgebrochen." : `${count} Übertragungen laufen und werden abgebrochen.`;
export const updateStartNote = "Fragt beim Start einmal pkg.werklade.de ab. Es werden keine Daten übertragen.";
export const notesMaxChars = 4000;
export const notesMaxLines = 60;
const versionMaxChars = 64;

const installKindLabels: Record<InstallKind, string> = {
  appimage: "AppImage", deb: "DEB-Paket", rpm: "RPM-Paket", nsis: "Windows-Installer (NSIS)", msi: "Windows-Installer (MSI)", other: "Sonstige Installation",
};
export const installKindLabel = (kind: InstallKind): string => installKindLabels[kind] ?? installKindLabels.other;
/** "AppImage, Testkanal" for the About dialog. */
export const describeInstall = (info: Pick<UpdateInfo, "installKind" | "channel">): string =>
  [installKindLabel(info.installKind), ...(info.channel === "test" ? ["Testkanal"] : [])].join(", ");
export const isWindowsInstaller = (kind: InstallKind): boolean => kind === "nsis" || kind === "msi";

/**
 * Notes shown before the install. On Windows the backend ends the process itself once the installer runs, so the
 * call never returns there; everything that must happen before quitting is done before update_install.
 */
export function restartHints(kind: InstallKind): string[] {
  if (kind === "nsis") return ["Werkterm wird beendet und nach dem Update neu gestartet. Offene Verbindungen werden getrennt."];
  if (kind === "msi") return ["Werkterm wird beendet und nach dem Update neu gestartet. Offene Verbindungen werden getrennt.", "Windows fragt nach dem Beenden nach Administratorrechten. Bei Ablehnung bleibt die bisherige Version installiert; Werkterm dann von Hand starten."];
  return ["Werkterm startet danach neu. Offene Verbindungen werden getrennt."];
}
/** Backend text stays as it is; the sentence names only what was actually stopped. */
export function withStoppedNote(message: string, stopped: { tunnels: boolean; logs: boolean }): string {
  if (!stopped.tunnels && !stopped.logs) return message;
  const what = stopped.tunnels && stopped.logs ? "Tunnel und Protokolle" : stopped.tunnels ? "Tunnel" : "Protokolle";
  const trimmed = message.trimEnd();
  return `${trimmed}${/[.!?]$/.test(trimmed) ? "" : "."} Gestoppte ${what} wurden nicht neu gestartet.`;
}

/** The start check follows the settings file that was actually loaded, never the localStorage cache. */
export const startCheckEnabled = (loaded: { updateCheckOnStart: boolean } | null | undefined): boolean => loaded?.updateCheckOnStart === true;

/** Wraps a handler so that late answers (after the dialog was closed) are dropped. */
export function guardLate<T>(isOpen: () => boolean, handler: (value: T) => void): (value: T) => void {
  return value => { if (isOpen()) handler(value); };
}

/** What the dialog offers for an available update. "blocked": the build can self-update but not here. */
export type UpdateAction = "install" | "blocked" | "apt" | "download";
export function updateAction(info: Pick<UpdateInfo, "selfUpdate" | "installKind" | "canInstall">): UpdateAction {
  if (info.selfUpdate) return info.canInstall ? "install" : "blocked";
  return info.installKind === "deb" ? "apt" : "download";
}

/** Plain text only: line breaks stay, control and bidi-override characters go, length is capped. */
export function sanitizeNotes(raw: string | null | undefined): { text: string; truncated: boolean } {
  if (typeof raw !== "string") return { text: "", truncated: false };
  let text = raw.replace(/\r\n?/g, "\n")
    // C0/C1 controls except \n and \t, bidi embeddings/overrides/isolates, BOM and zero-width characters.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  let truncated = false;
  const lines = text.split("\n");
  if (lines.length > notesMaxLines) { text = lines.slice(0, notesMaxLines).join("\n"); truncated = true; }
  if (text.length > notesMaxChars) {
    let end = notesMaxChars;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1; // do not split a surrogate pair
    text = text.slice(0, end); truncated = true;
  }
  if (truncated) text = `${text.trimEnd()}\n…`;
  return { text, truncated };
}

/** Version as shown: only characters that occur in version numbers, capped. Null when nothing usable remains. */
export function sanitizeVersion(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[^0-9A-Za-z.+_-]/g, "").slice(0, versionMaxChars);
  return cleaned || null;
}

export const invalidAnswerMessage = "Die Antwort der Update-Prüfung ist ungültig.";
export type CheckOutcome = { ok: true; update: AvailableUpdate | null } | { ok: false; message: string };
/** available=false -> up to date. available=true needs a usable version, otherwise the answer is rejected. */
export function interpretCheck(check: UpdateCheck): CheckOutcome {
  if (!check || typeof check !== "object") return { ok: false, message: invalidAnswerMessage };
  if (check.available !== true) return { ok: true, update: null };
  const version = sanitizeVersion(check.version);
  if (!version) return { ok: false, message: invalidAnswerMessage };
  const notes = sanitizeNotes(check.notes);
  return { ok: true, update: { version, notes: notes.text, notesTruncated: notes.truncated, pubDate: typeof check.pubDate === "string" ? check.pubDate : null } };
}

/** Local date (dd.mm.yyyy in German); null for missing or unparsable input. */
export function formatPubDate(pubDate: string | null, locale?: string, timeZone?: string): string | null {
  if (!pubDate) return null;
  const time = Date.parse(pubDate);
  if (!Number.isFinite(time)) return null;
  try { return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone }).format(new Date(time)); }
  catch { return null; }
}

/** 0..100 or null (indeterminate) when the total is unknown or not positive. */
export function progressPercent(downloaded: number, total: number | null): number | null {
  if (total === null || !Number.isFinite(total) || total <= 0 || !Number.isFinite(downloaded)) return null;
  return Math.max(0, Math.min(100, Math.floor(downloaded / total * 100)));
}
/** Backend messages are not trusted blindly: negative or non-finite numbers become 0 / unknown. */
export function normalizeProgress(raw: Partial<UpdateProgress> | null | undefined): UpdateProgress {
  const downloaded = typeof raw?.downloaded === "number" && Number.isFinite(raw.downloaded) && raw.downloaded > 0 ? raw.downloaded : 0;
  const total = typeof raw?.total === "number" && Number.isFinite(raw.total) && raw.total > 0 ? raw.total : null;
  return { downloaded, total };
}
export function progressText(downloaded: number, total: number | null): string {
  const percent = progressPercent(downloaded, total);
  if (percent === null || total === null) return `${formatSize(downloaded)} heruntergeladen`;
  return `${formatSize(downloaded)} von ${formatSize(total)} (${percent} %)`;
}

export type RetryTarget = "info" | "check" | "install";
export type UpdateState =
  | { phase: "loading" }
  | { phase: "notConfigured"; info: UpdateInfo }
  | { phase: "checking"; info: UpdateInfo }
  | { phase: "current"; info: UpdateInfo }
  | { phase: "available"; info: UpdateInfo; update: AvailableUpdate }
  | { phase: "installing"; info: UpdateInfo; update: AvailableUpdate; progress: UpdateProgress }
  | { phase: "restarting"; info: UpdateInfo; update: AvailableUpdate }
  | { phase: "error"; info: UpdateInfo | null; update: AvailableUpdate | null; message: string; retry: RetryTarget };
export type UpdateEvent =
  | { type: "info"; info: UpdateInfo }
  | { type: "checked"; check: UpdateCheck }
  | { type: "install" }
  | { type: "progress"; progress: UpdateProgress }
  | { type: "installed" }
  /** The user turned down a question before the install (open SSH sessions, unsaved editors): back to the offer. */
  | { type: "declined" }
  | { type: "failed"; message: string }
  | { type: "retry" };
export const initialUpdateState: UpdateState = { phase: "loading" };

/** Events that do not fit the current phase are ignored (late answers after closing, double clicks). */
export function updateReducer(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case "info":
      if (state.phase !== "loading") return state;
      return event.info.configured ? { phase: "checking", info: event.info } : { phase: "notConfigured", info: event.info };
    case "checked": {
      if (state.phase !== "checking") return state;
      const outcome = interpretCheck(event.check);
      if (!outcome.ok) return { phase: "error", info: state.info, update: null, message: outcome.message, retry: "check" };
      return outcome.update ? { phase: "available", info: state.info, update: outcome.update } : { phase: "current", info: state.info };
    }
    case "install":
      if (state.phase !== "available" || updateAction(state.info) !== "install") return state;
      return { phase: "installing", info: state.info, update: state.update, progress: { downloaded: 0, total: null } };
    case "progress":
      return state.phase === "installing" ? { ...state, progress: normalizeProgress(event.progress) } : state;
    case "installed":
      return state.phase === "installing" ? { phase: "restarting", info: state.info, update: state.update } : state;
    case "declined":
      return state.phase === "installing" ? { phase: "available", info: state.info, update: state.update } : state;
    case "failed":
      if (state.phase === "loading") return { phase: "error", info: null, update: null, message: event.message, retry: "info" };
      if (state.phase === "checking") return { phase: "error", info: state.info, update: null, message: event.message, retry: "check" };
      if (state.phase === "installing" || state.phase === "restarting") return { phase: "error", info: state.info, update: state.update, message: event.message, retry: "install" };
      return state;
    case "retry":
      if (state.phase !== "error") return state;
      if (state.retry === "info" || !state.info) return initialUpdateState;
      if (state.retry === "check") return { phase: "checking", info: state.info };
      return state.update ? { phase: "installing", info: state.info, update: state.update, progress: { downloaded: 0, total: null } } : { phase: "checking", info: state.info };
  }
}

/** Esc and the close button are blocked while the install runs: the backend offers no cancel. */
export const canCloseUpdateDialog = (state: UpdateState): boolean => state.phase !== "installing" && state.phase !== "restarting";

/** Whether the start check runs: the user switched it on and the data folder (settings) is loaded. */
export function shouldCheckOnStart(input: { enabled: boolean; dataReady: boolean; alreadyDecided: boolean }): boolean {
  return input.enabled && input.dataReady && !input.alreadyDecided;
}

export interface StartupDeps { info(): Promise<UpdateInfo>; check(): Promise<UpdateCheck> }
/**
 * Start check, at most once per program run. The decision is made the first time the app is ready: a setting
 * switched on later does not trigger a check before the next start. Errors are discarded; the result is only
 * the version of an available update.
 */
export function createStartupChecker(deps: StartupDeps) {
  let decided = false;
  return {
    async run(enabled: boolean, dataReady: boolean): Promise<AvailableUpdate | null> {
      if (!dataReady || decided) return null;
      const go = shouldCheckOnStart({ enabled, dataReady, alreadyDecided: decided });
      decided = true;
      if (!go) return null;
      try {
        const info = await deps.info();
        if (!info.configured) return null;
        const outcome = interpretCheck(await deps.check());
        return outcome.ok ? outcome.update : null;
      } catch { return null; }
    },
  };
}
