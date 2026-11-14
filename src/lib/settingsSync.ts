import { errorText } from "./backendError";
import { t } from "../i18n";
import { cachedSettingsText, interpretLoaded, mergeSettings, normalizeSettings, saveSettings, serializeSettings, type Settings } from "./settings";
import { isSettingsConflict, settingsLoadRaw, settingsSaveRaw, type FileStamp, type LoadedSettingsFile } from "./dataDir";

/**
 * Debounce state of the settings file writer (pure).
 * `saved` is the last content known to be in the file (or, without a file, the content loaded at start, so that
 * derived non-changes never create it), `inflight` the content being written, `pending` the newest queued content.
 * Writes are only accepted once loading has succeeded.
 */
export interface WriterState { enabled: boolean; pending: string | null; inflight: string | null; saved: string | null }
export const initialWriter: WriterState = { enabled: false, pending: null, inflight: null, saved: null };
export const enableWriter = (saved: string | null): WriterState => ({ enabled: true, pending: null, inflight: null, saved });
export const disableWriter = (): WriterState => initialWriter;
/** The last queued change wins; a value equal to the newest known content is dropped unless `force` is set. */
export function queueWrite(state: WriterState, json: string, force = false): WriterState {
  if (!state.enabled) return state;
  const tail = state.pending ?? state.inflight ?? state.saved;
  return json === tail && !force ? state : { ...state, pending: json };
}
export function takePending(state: WriterState): { state: WriterState; json: string | null } {
  if (state.pending === null) return { state, json: null };
  return { state: { ...state, pending: null, inflight: state.pending }, json: state.pending };
}
/** A failed write is queued again (unless something newer is queued) so the next flush retries it. */
export function finishWrite(state: WriterState, json: string, ok: boolean, saved: string = json): WriterState {
  if (!state.enabled) return state;
  if (ok) return { ...state, inflight: null, saved };
  return { ...state, inflight: null, pending: state.pending ?? json };
}
export const hasOutstandingWrite = (state: WriterState): boolean => state.pending !== null || state.inflight !== null;

/** One-shot marker: "the user chose to copy the old data into the new folder", read by the next start. */
const migrateFlagKey = "werkterm.migrate-settings";
export function setMigrateFlag(value: boolean): void {
  try { if (value) localStorage.setItem(migrateFlagKey, "1"); else localStorage.removeItem(migrateFlagKey); } catch { /* storage unavailable */ }
}
export function takeMigrateFlag(): boolean {
  try { const value = localStorage.getItem(migrateFlagKey) === "1"; localStorage.removeItem(migrateFlagKey); return value; } catch { return false; }
}

export interface SettingsIo {
  load(): Promise<LoadedSettingsFile | null>;
  save(json: string, base: FileStamp | null): Promise<FileStamp>;
  readCache(): string | null;
  writeCache(settings: Settings): void;
}
export const fileSettingsIo: SettingsIo = { load: settingsLoadRaw, save: settingsSaveRaw, readCache: cachedSettingsText, writeCache: saveSettings };

export interface SettingsSyncHooks {
  /** An own write succeeded; `stamp` is the new settings.json stamp. */
  onSaved?(stamp: FileStamp): void;
  /** A write conflict was resolved by merging; the merged result should replace the current state. */
  onMerged?(settings: Settings): void;
}
export const conflictReason = (): string => t("error.SETTINGS_CONFLICT");

export class SettingsSync {
  private state: WriterState = initialWriter;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** Stamp (null = no file) and normalized content of the version last loaded or written. */
  private base: { stamp: FileStamp | null; settings: Settings | null } = { stamp: null, settings: null };
  private latest: Settings | null = null;
  private locked = false;
  constructor(
    private readonly io: SettingsIo,
    private readonly report: (message: string) => void,
    private readonly hooks: SettingsSyncHooks = {},
    private readonly delay = 300,
  ) {}

  get writable(): boolean { return this.state.enabled; }
  hasPending(): boolean { return hasOutstandingWrite(this.state); }

  /** Stops all file writes (folder unreachable, unreadable file, or folder switch in progress). A later load re-enables them. */
  block(): void {
    this.clearTimer();
    this.state = disableWriter();
  }

  /** Permanent block after the data folder was switched: neither loading nor writing is possible any more. */
  lock(): void {
    this.locked = true;
    this.block();
  }
  get isLocked(): boolean { return this.locked; }

  /**
   * Loads settings.json; on failure returns null and keeps writing disabled.
   * `migrate` allows adopting the localStorage cache once when no file exists.
   */
  async load(options: { migrate?: boolean } = {}): Promise<Settings | null> {
    if (this.locked) return null;
    let file: LoadedSettingsFile | null;
    try { file = await this.io.load(); } catch (reason) { return this.fail(errorText(reason)); }
    return this.adopt(file, options.migrate ?? false);
  }

  /** Reload after an external change; skipped (null) while an own write is outstanding, also if one appears during loading. */
  async reloadExternal(): Promise<Settings | null> {
    if (this.locked || this.hasPending()) return null;
    let file: LoadedSettingsFile | null;
    try { file = await this.io.load(); } catch (reason) { return this.fail(errorText(reason)); }
    if (this.locked || this.hasPending()) return null;
    return this.adopt(file, false);
  }

  /** Updates the cache at once and queues a debounced file write. */
  schedule(settings: Settings): void {
    this.io.writeCache(settings);
    this.latest = settings;
    this.state = queueWrite(this.state, serializeSettings(settings));
    this.arm();
  }

  /** Writes outstanding changes now (also used when the window closes). Never rejects. */
  flush(): Promise<void> {
    this.clearTimer();
    const taken = takePending(this.state);
    this.state = taken.state;
    const json = taken.json;
    const mine = this.latest;
    if (json !== null && mine !== null) this.chain = this.chain.then(() => this.write(json, mine));
    return this.chain;
  }

  private async adopt(file: LoadedSettingsFile | null, migrate: boolean): Promise<Settings | null> {
    const outcome = interpretLoaded(file?.json ?? null, this.io.readCache(), migrate);
    if (!outcome.ok) return this.fail(outcome.error);
    this.clearTimer();
    this.base = { stamp: file ? { modifiedMs: file.modifiedMs, size: file.size } : null, settings: outcome.settings };
    this.state = enableWriter(serializeSettings(outcome.settings));
    // Without a file and without migration the cache keeps the old local values (way back); it is refreshed by the next change.
    if (file || outcome.migrated) this.io.writeCache(outcome.settings);
    if (outcome.migrated) {
      this.latest = outcome.settings;
      this.state = queueWrite(this.state, serializeSettings(outcome.settings), true);
      await this.flush();
    }
    return outcome.settings;
  }

  private async write(json: string, mine: Settings): Promise<void> {
    try {
      const stamp = await this.io.save(json, this.base.stamp);
      this.state = finishWrite(this.state, json, true);
      this.base = { stamp, settings: normalizeSettings(mine) };
      this.hooks.onSaved?.(stamp);
    } catch (reason) {
      if (isSettingsConflict(reason)) await this.resolveConflict(json, mine);
      else this.writeFailed(json, errorText(reason));
    }
  }

  /** Reload, lay the own changed keys over the current file, try once more. */
  private async resolveConflict(json: string, mine: Settings): Promise<void> {
    try {
      const file = await this.io.load();
      let theirs = mine;
      if (file) {
        const outcome = interpretLoaded(file.json, this.io.readCache(), false);
        if (!outcome.ok) throw new Error(outcome.error);
        theirs = outcome.settings;
      }
      const merged = mergeSettings(this.base.settings, mine, theirs);
      const mergedJson = serializeSettings(merged);
      const stamp = await this.io.save(mergedJson, file ? { modifiedMs: file.modifiedMs, size: file.size } : null);
      const newerQueued = this.state.pending !== null;
      this.state = finishWrite(this.state, json, true, mergedJson);
      this.base = { stamp, settings: merged };
      this.hooks.onSaved?.(stamp);
      if (!newerQueued) { this.latest = merged; this.io.writeCache(merged); this.hooks.onMerged?.(merged); }
    } catch (reason) {
      this.writeFailed(json, isSettingsConflict(reason) ? conflictReason() : errorText(reason));
    }
  }

  private writeFailed(json: string, reason: string): void {
    this.state = finishWrite(this.state, json, false);
    this.report(t("sync.saveFailed", { reason }));
  }
  private arm(): void {
    if (this.state.pending === null) return;
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.delay);
  }
  private fail(reason: string): null {
    this.block();
    this.report(t("sync.loadFailed", { reason }));
    return null;
  }
  private clearTimer(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  }
}
