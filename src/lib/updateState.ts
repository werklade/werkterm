import { formatSize } from "./formatSize";
import { currentLocale, t, tp } from "../i18n";

// Pure logic of the update check: no network, no Tauri. The invoke layer lives in update.ts.

export type InstallKind = "appimage" | "deb" | "rpm" | "nsis" | "msi" | "other";
export interface UpdateInfo {
  currentVersion: string; installKind: InstallKind; selfUpdate: boolean; channel: "stable" | "test";
  /** true: WERKTERM_UPDATE_CHANNEL chose the channel and the setting has no effect. Missing in older backends. */
  channelFromEnv?: boolean;
  configured: boolean;
  /** false although selfUpdate: the install cannot run here (e.g. AppImage folder not writable); blockedReason says why. */
  canInstall: boolean; blockedReason: string | null;
}
/** Raw answer of update_check; every text field comes from the server and is untrusted. */
export interface UpdateCheck {
  available: boolean; version: string | null; notes: string | null; pubDate: string | null;
  /** The offered version is older than the installed one (stable channel while a test build is installed). */
  downgrade?: boolean;
  /** Test channel: manifest that could not be read while the other one was used, and its error code. */
  skippedManifest?: "test" | "stable"; partialError?: string;
}
/** A manifest that was not checked; the result is based on the other one only. */
export interface SkippedManifest { manifest: "test" | "stable"; code: string }
export interface UpdateProgress { downloaded: number; total: number | null }
/** An update announcement after sanitizing; safe to render as plain text. */
export interface AvailableUpdate { version: string; notes: string; notesTruncated: boolean; pubDate: string | null; downgrade: boolean; skipped: SkippedManifest | null }
/** What update_install gets: the version the user saw and whether they confirmed it as a downgrade. */
export interface InstallRequest { channel: "stable" | "test"; version: string; allowDowngrade: boolean }
/** The install request for an offer the user accepted; a downgrade offer is only installed through its own confirm button. */
export const installRequest = (channel: "stable" | "test", update: AvailableUpdate): InstallRequest =>
  ({ channel, version: update.version, allowDowngrade: update.downgrade });

export const updateDownloadUrl = "https://pkg.werklade.de/werkterm/";
export const aptCommand = "sudo apt update && sudo apt install --only-upgrade werkterm";
export const aptRepoNote = (): string => t("update.aptRepoNote");
export const blockedFallback = (): string => t("update.blockedFallback");
/** Exact error string of update_install: the process was shut down but the installer did not start. */
export const restartRequiredCode = "UPDATE_RESTART_REQUIRED";
export const restartRequiredMessage = (): string => t("error.UPDATE_RESTART_REQUIRED");
export const isRestartRequired = (reason: unknown): boolean => (reason instanceof Error ? reason.message : reason) === restartRequiredCode;
export const transfersMessage = (count: number): string => tp("update.transfers", count);
export const updateStartNote = (): string => t("update.startNote");
export const notesMaxChars = 4000;
export const notesMaxLines = 60;
const versionMaxChars = 64;

const installKindKeys = {
  appimage: "update.kind.appimage", deb: "update.kind.deb", rpm: "update.kind.rpm", nsis: "update.kind.nsis", msi: "update.kind.msi", other: "update.kind.otherInstall",
} as const;
export const installKindLabel = (kind: InstallKind): string => t(installKindKeys[kind] ?? installKindKeys.other);
/** "AppImage, Testkanal" for the About dialog. */
export const describeInstall = (info: Pick<UpdateInfo, "installKind" | "channel">): string =>
  [installKindLabel(info.installKind), ...(info.channel === "test" ? [t("update.channel.test")] : [])].join(", ");
export const isWindowsInstaller = (kind: InstallKind): boolean => kind === "nsis" || kind === "msi";

/**
 * Notes shown before the install. On Windows the backend ends the process itself once the installer runs, so the
 * call never returns there; everything that must happen before quitting is done before update_install.
 */
export function restartHints(kind: InstallKind): string[] {
  if (kind === "nsis") return [t("update.restart.windows")];
  if (kind === "msi") return [t("update.restart.windows"), t("update.restart.admin")];
  return [t("update.restart.linux")];
}
/** Backend text stays as it is; the sentence names only what was actually stopped. */
export function withStoppedNote(message: string, stopped: { tunnels: boolean; logs: boolean }): string {
  if (!stopped.tunnels && !stopped.logs) return message;
  const note = t(stopped.tunnels && stopped.logs ? "update.stopped.both" : stopped.tunnels ? "update.stopped.tunnels" : "update.stopped.logs");
  const trimmed = message.trimEnd();
  return `${trimmed}${/[.!?]$/.test(trimmed) ? "" : "."} ${note}`;
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

export const invalidAnswerMessage = (): string => t("update.invalidAnswer");
const errorCodePattern = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Only a known manifest name with an error code counts; anything else from the backend is dropped. */
export function skippedManifest(check: UpdateCheck | null | undefined): SkippedManifest | null {
  if (!check || typeof check !== "object") return null;
  const { skippedManifest: manifest, partialError: code } = check;
  if ((manifest !== "test" && manifest !== "stable") || typeof code !== "string" || !errorCodePattern.test(code)) return null;
  return { manifest, code };
}
/** "Testkanal nicht erreichbar, nur Stable geprüft." – the reason is added by the view. */
export const skippedNote = (skipped: SkippedManifest): string => t(skipped.manifest === "test" ? "update.skipped.test" : "update.skipped.stable");
/**
 * Notes under the channel setting: the environment variable overrides it; installs that do not update themselves
 * only report versions (deb additionally waits for the APT test suite, #15).
 */
export function channelNotes(info: Pick<UpdateInfo, "channel" | "channelFromEnv" | "selfUpdate" | "installKind"> | null): string[] {
  if (!info) return [];
  const notes: string[] = [];
  if (info.channelFromEnv) notes.push(t("settings.updates.channel.env", { channel: t(info.channel === "test" ? "settings.updates.channel.test" : "settings.updates.channel.stable") }));
  if (!info.selfUpdate) notes.push(t("settings.updates.channel.noSelfUpdate"));
  if (info.installKind === "deb") notes.push(t("settings.updates.channel.deb"));
  return notes;
}
export type CheckOutcome = { ok: true; update: AvailableUpdate | null } | { ok: false; message: string };
/** available=false -> up to date. available=true needs a usable version, otherwise the answer is rejected. */
export function interpretCheck(check: UpdateCheck): CheckOutcome {
  if (!check || typeof check !== "object") return { ok: false, message: invalidAnswerMessage() };
  if (check.available !== true) return { ok: true, update: null };
  const version = sanitizeVersion(check.version);
  if (!version) return { ok: false, message: invalidAnswerMessage() };
  const notes = sanitizeNotes(check.notes);
  return { ok: true, update: { version, notes: notes.text, notesTruncated: notes.truncated, pubDate: typeof check.pubDate === "string" ? check.pubDate : null, downgrade: check.downgrade === true, skipped: skippedManifest(check) } };
}

/** Local date in the UI language (dd.mm.yyyy in German); null for missing or unparsable input. */
export function formatPubDate(pubDate: string | null, locale: string = currentLocale(), timeZone?: string): string | null {
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
  if (percent === null || total === null) return t("update.progress.downloaded", { size: formatSize(downloaded) });
  return t("update.progress.of", { done: formatSize(downloaded), total: formatSize(total), percent });
}

export type RetryTarget = "info" | "check" | "install";
export type UpdateState =
  | { phase: "loading" }
  | { phase: "notConfigured"; info: UpdateInfo }
  | { phase: "checking"; info: UpdateInfo }
  /** skipped: the result rests on one manifest only (test channel, the other one failed). */
  | { phase: "current"; info: UpdateInfo; skipped?: SkippedManifest | null }
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
      return outcome.update ? { phase: "available", info: state.info, update: outcome.update } : { phase: "current", info: state.info, skipped: skippedManifest(event.check) };
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

/** check gets the effective channel reported by info (environment variable or setting). */
export interface StartupDeps { info(): Promise<UpdateInfo>; check(channel: UpdateInfo["channel"]): Promise<UpdateCheck> }
/** Version for the status bar marker; a downgrade is not an update and gets no marker. */
export const markerVersion = (update: AvailableUpdate | null): string | null => update && !update.downgrade ? update.version : null;

/**
 * Start check, at most once per program run. The decision is made the first time the app is ready: a setting
 * switched on later does not trigger a check before the next start. Errors are discarded; the result is only
 * the version of an available update; a downgrade offer (back to stable) is only shown in the update dialog.
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
        const outcome = interpretCheck(await deps.check(info.channel));
        return outcome.ok && outcome.update && !outcome.update.downgrade ? outcome.update : null;
      } catch { return null; }
    },
  };
}
