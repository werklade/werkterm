import { backendErrorText, localFileName, transferText, type TransferProgress } from "./transferFormat";
import { errorCode } from "./backendError";
import { t, tp } from "../i18n";
import { parentPath } from "./paths";

export type TransferJob =
  | { kind: "download"; sessionId: number; remotePath: string; localPath: string; overwrite?: boolean }
  | { kind: "upload"; sessionId: number; localPath: string; remoteDir: string; overwrite?: boolean }
  /** Downloads the remote folder into a new or existing folder of the same name inside `localParent`. */
  | { kind: "downloadFolder"; sessionId: number; remotePath: string; localParent: string }
  /** Uploads the local folder into a new or existing folder of the same name inside `remoteDir`. */
  | { kind: "uploadFolder"; sessionId: number; localPath: string; remoteDir: string };
export type ConflictResolution = "overwrite" | "skip" | "overwriteAll" | "cancel";
export type QueueState = { text: string; queued: number } | null;
type Direction = "upload" | "download";
export interface TransferFinished { sessionId: number; dir: string; kind: Direction; error?: string; cancelled?: boolean; summary?: string }
export interface TreeListing { dirs: string[]; files: { path: string; size: number; executable: boolean }[]; skippedSymlinks: number; skippedOther: number; skippedInvalid: number }
export interface TransferDependencies<C> {
  download: (sessionId: number, remotePath: string, localPath: string, overwrite: boolean, transferId: number, channel: C) => Promise<void>;
  upload: (sessionId: number, localPath: string, remoteDir: string, overwrite: boolean, transferId: number, channel: C) => Promise<void>;
  cancel: (transferId: number) => Promise<void>;
  allocateId: () => number;
  createChannel: (update: (progress: TransferProgress) => void) => C;
  resolveConflict: (name: string, signal: AbortSignal) => Promise<ConflictResolution>;
  report: (message: string) => void;
  /** Listings are cancellable through `cancel(transferId)` like transfers. */
  listRemoteTree: (sessionId: number, path: string, transferId: number) => Promise<TreeListing>;
  listLocalTree: (path: string, transferId: number) => Promise<TreeListing>;
  ensureRemoteDir: (sessionId: number, path: string) => Promise<void>;
  ensureLocalDir: (path: string) => Promise<void>;
  /** Separator of the local platform (`\` on Windows, `/` elsewhere). */
  localSeparator: () => string;
}
interface Batch { overwriteAll: boolean }
/** One expanded folder; its files run as separate queue entries. */
interface Folder { name: string; kind: Direction; sessionId: number; dir: string; total: number; processed: number; transferred: number; failedPaths: string[]; skippedLinks: number; skippedOther: number; skippedInvalid: number; closed: boolean }
interface Entry { job: TransferJob; batch: Batch; folder?: Folder; /** Path of a folder file relative to the folder. */ relative?: string }
type FolderEnd = { state: "done" } | { state: "cancelled" } | { state: "failed"; reason: string };
interface Active extends Entry { controller: AbortController; transferId?: number; text: string; cancellation?: Promise<void> }
type Outcome = "done" | "skipped" | "expanded";
export type TransferQueueHandle = Pick<TransferQueue<unknown>, "enqueue" | "onFinished">;

const direction = (job: TransferJob): Direction => job.kind === "upload" || job.kind === "uploadFolder" ? "upload" : "download";
const remoteName = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;
const remoteJoin = (parent: string, relative: string) => relative ? `${parent.replace(/\/+$/, "")}/${relative}` : parent;
const validName = (name: string) => name.length > 0 && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
/** Parent of a `/`-joined relative path (`""` for top-level entries). */
/** Errors after which no further file of the session can succeed. */
const SESSION_ERRORS = new Set(["SSH_UNKNOWN_SESSION", "SESSION_CLOSED", "SFTP_ONLY", "SFTP_CLOSED"]);
/** How many failed paths the folder summary names. */
const LISTED_FAILURES = 5;
/** Resolves `undefined` as soon as `signal` aborts; a late rejection of `work` is ignored. */
function unlessAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T | undefined> {
  work.catch(() => undefined);
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const stop = () => resolve(undefined);
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
const relativeParent = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** A serial queue whose lifetime is independent of the visible file browser. */
export class TransferQueue<C> {
  private pending: Entry[] = [];
  private active: Active | null = null;
  private listeners = new Set<(state: QueueState) => void>();
  private finished = new Set<(event: TransferFinished) => void>();
  private running = false;
  private cancelledSessions = new Set<number>();
  constructor(private readonly dependencies: TransferDependencies<C>) {}

  enqueue(jobs: TransferJob[]): void {
    const batch: Batch = { overwriteAll: false };
    this.pending.push(...jobs.filter(job => !this.cancelledSessions.has(job.sessionId)).map(job => ({ job: { ...job }, batch })));
    this.emit();
    void this.drain();
  }
  subscribe(listener: (state: QueueState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => { this.listeners.delete(listener); };
  }
  onFinished(listener: (event: TransferFinished) => void): () => void {
    this.finished.add(listener);
    return () => { this.finished.delete(listener); };
  }
  /** Cancels the running job and the rest of its batch, including the remaining files of its folders. */
  cancelCurrent(): void {
    const active = this.active;
    if (!active || active.controller.signal.aborted) return;
    this.drop(entry => entry.batch === active.batch);
    this.abort(active);
    this.emit();
  }
  /** Session IDs identify a connection; closed sessions also reject late native-dialog selections. */
  cancelSession(sessionId: number): void {
    if (this.cancelledSessions.has(sessionId)) return;
    this.cancelledSessions.add(sessionId);
    this.drop(entry => entry.job.sessionId === sessionId);
    if (this.active?.job.sessionId === sessionId) this.abort(this.active);
    this.emit();
  }
  countSession(sessionId: number): number {
    return this.pending.filter(entry => entry.job.sessionId === sessionId).length + Number(this.active?.job.sessionId === sessionId && !this.active.controller.signal.aborted);
  }
  /** Running and queued jobs of all sessions. */
  count(): number {
    return this.pending.length + Number(!!this.active && !this.active.controller.signal.aborted);
  }
  private state(): QueueState {
    return this.active ? { text: this.active.text, queued: this.pending.length } : null;
  }
  private emit(): void { for (const listener of this.listeners) listener(this.state()); }
  private notify(event: TransferFinished): void { for (const listener of this.finished) listener(event); }
  /** Removes waiting entries; folders that lose files end as cancelled (the active one when it settles). */
  private drop(remove: (entry: Entry) => boolean): void {
    const removed = this.pending.filter(remove);
    this.pending = this.pending.filter(entry => !remove(entry));
    for (const entry of removed) if (entry.folder && entry.folder !== this.active?.folder) this.closeFolder(entry.folder, { state: "cancelled" });
  }
  private abort(active: Active): void {
    if (active.controller.signal.aborted) return;
    active.controller.abort();
    if (active.transferId !== undefined) {
      active.cancellation = this.dependencies.cancel(active.transferId).catch(reason => {
        this.dependencies.report(t("transfer.cancelFailed", { reason: backendErrorText(reason) }));
      });
    }
  }
  private label(active: Active, progress: TransferProgress): string {
    const { job, folder } = active;
    const name = job.kind === "upload" ? localFileName(job.localPath) : job.kind === "download" ? job.remotePath.split("/").pop() ?? job.remotePath : "";
    const text = transferText(job.kind === "upload" ? "↑" : "↓", name, progress);
    return folder ? `${t("transfer.folderProgress", { name: folder.name, current: Math.min(folder.total, folder.processed + 1), total: folder.total })} · ${text}` : text;
  }
  private async transfer(active: Active, overwrite: boolean): Promise<void> {
    if (active.controller.signal.aborted) return;
    const { job } = active;
    if (job.kind !== "upload" && job.kind !== "download") return;
    const transferId = this.dependencies.allocateId();
    const update = (progress: TransferProgress) => {
      if (this.active !== active || (active.transferId !== transferId || progress.transferId !== transferId) || active.controller.signal.aborted) return;
      active.text = this.label(active, progress);
      this.emit();
    };
    active.text = this.label(active, { transferId, done: 0, total: null });
    this.emit();
    try {
      const channel = this.dependencies.createChannel(update);
      if (active.controller.signal.aborted) return;
      active.transferId = transferId;
      if (job.kind === "download") await this.dependencies.download(job.sessionId, job.remotePath, job.localPath, overwrite, transferId, channel);
      else await this.dependencies.upload(job.sessionId, job.localPath, job.remoteDir, overwrite, transferId, channel);
    } finally { active.transferId = undefined; }
  }
  /** Lists a folder, creates its directories (parents first) and queues one entry per file in front of the queue. */
  private async expand(active: Active, job: Extract<TransferJob, { kind: "downloadFolder" | "uploadFolder" }>): Promise<Outcome> {
    const signal = active.controller.signal;
    const upload = job.kind === "uploadFolder";
    const name = upload ? localFileName(job.localPath) : remoteName(job.remotePath);
    if (!validName(name)) throw "INVALID_NAME";
    const separator = this.dependencies.localSeparator();
    const localJoin = (base: string, relative: string) => relative ? `${base.replace(/[\\/]+$/, "")}${separator}${relative.split("/").join(separator)}` : base;
    const localRoot = upload ? job.localPath : localJoin(job.localParent, name);
    const remoteRoot = upload ? remoteJoin(job.remoteDir, name) : job.remotePath;
    active.text = t("transfer.folderReading", { name });
    this.emit();
    // The listing runs under a transfer ID: Cancel stops it in the backend and frees the queue at once.
    const transferId = this.dependencies.allocateId();
    active.transferId = transferId;
    let tree: TreeListing | undefined;
    try { tree = await unlessAborted(signal, upload ? this.dependencies.listLocalTree(job.localPath, transferId) : this.dependencies.listRemoteTree(job.sessionId, job.remotePath, transferId)); }
    finally { active.transferId = undefined; }
    if (!tree || signal.aborted) return "done";
    active.text = t("transfer.folderCreating", { name });
    this.emit();
    for (const relative of ["", ...tree.dirs]) {
      if (signal.aborted) return "done";
      if (upload) await this.dependencies.ensureRemoteDir(job.sessionId, remoteJoin(remoteRoot, relative));
      else await this.dependencies.ensureLocalDir(localJoin(localRoot, relative));
    }
    if (signal.aborted) return "done";
    const folder: Folder = { name, kind: direction(job), sessionId: job.sessionId, dir: upload ? job.remoteDir : parentPath(job.remotePath), total: tree.files.length, processed: 0, transferred: 0, failedPaths: [], skippedLinks: tree.skippedSymlinks, skippedOther: tree.skippedOther, skippedInvalid: tree.skippedInvalid, closed: false };
    const entries: Entry[] = tree.files.map(file => ({
      batch: active.batch,
      folder,
      relative: file.path,
      job: upload
        ? { kind: "upload", sessionId: job.sessionId, localPath: localJoin(localRoot, file.path), remoteDir: remoteJoin(remoteRoot, relativeParent(file.path)), overwrite: false }
        : { kind: "download", sessionId: job.sessionId, remotePath: remoteJoin(remoteRoot, file.path), localPath: localJoin(localRoot, file.path), overwrite: false },
    }));
    this.pending.unshift(...entries);
    if (entries.length === 0) this.closeFolder(folder, { state: "done" });
    return "expanded";
  }
  private async execute(active: Active): Promise<Outcome> {
    const { job } = active;
    if (job.kind === "downloadFolder" || job.kind === "uploadFolder") return this.expand(active, job);
    const overwrite = job.kind === "download" ? (job.overwrite ?? true) || active.batch.overwriteAll : job.overwrite === true || active.batch.overwriteAll;
    try { await this.transfer(active, overwrite); }
    catch (reason: unknown) {
      if (active.controller.signal.aborted) return "done";
      // Dropped folders arrive as plain uploads; the backend tells them apart.
      if (job.kind === "upload" && !active.folder && errorCode(reason) === "DIRECTORY") return this.expand(active, { kind: "uploadFolder", sessionId: job.sessionId, localPath: job.localPath, remoteDir: job.remoteDir });
      if (errorCode(reason) !== "EXISTS") throw reason;
      const signal = active.controller.signal;
      // Cancellation releases the queue even if an injected dialog never answers.
      let stop: () => void = () => undefined;
      const cancelled = new Promise<ConflictResolution>(resolve => {
        stop = () => resolve("cancel");
        signal.addEventListener("abort", stop, { once: true });
      });
      let answer: ConflictResolution;
      try { answer = await Promise.race([cancelled, this.dependencies.resolveConflict(localFileName(job.localPath), signal)]); }
      finally { signal.removeEventListener("abort", stop); }
      if (signal.aborted) return "done";
      if (answer === "cancel") { this.cancelCurrent(); return "done"; }
      if (answer === "skip") return "skipped";
      if (answer === "overwriteAll") active.batch.overwriteAll = true;
      await this.transfer(active, true);
    }
    return "done";
  }
  private closeFolder(folder: Folder, end: FolderEnd): void {
    if (folder.closed) return;
    folder.closed = true;
    const counts = { name: folder.name, done: folder.transferred, total: folder.total };
    const parts = [end.state === "done" ? t(folder.kind === "upload" ? "transfer.folderUploaded" : "transfer.folderDownloaded", counts)
      : end.state === "cancelled" ? t("transfer.folderCancelled", counts) : t("transfer.folderAborted", { ...counts, reason: end.reason })];
    const failed = folder.failedPaths.length;
    if (failed) {
      const more = failed - LISTED_FAILURES;
      const listed = [...folder.failedPaths.slice(0, LISTED_FAILURES), ...(more > 0 ? [t("transfer.folderMore", { count: more })] : [])];
      parts.push(`${tp("transfer.folderFailed", failed)} (${listed.join(", ")})`);
    }
    if (folder.skippedLinks) parts.push(tp("transfer.folderSkippedLinks", folder.skippedLinks));
    if (folder.skippedOther) parts.push(tp("transfer.folderSkippedOther", folder.skippedOther));
    if (folder.skippedInvalid) parts.push(tp("transfer.folderSkippedInvalid", folder.skippedInvalid));
    const summary = parts.join(", ");
    const error = end.state === "failed" ? end.reason : failed ? tp("transfer.folderFailed", failed) : undefined;
    this.notify({ sessionId: folder.sessionId, dir: folder.dir, kind: folder.kind, summary, ...(end.state === "cancelled" ? { cancelled: true } : {}), ...(error === undefined ? {} : { error }) });
  }
  private settle(active: Active, outcome: Outcome, error: string | undefined, code: string | undefined): void {
    const { job, folder } = active;
    const aborted = active.controller.signal.aborted;
    if (folder) {
      folder.processed++;
      if (error !== undefined) folder.failedPaths.push(active.relative ?? "?");
      else if (outcome === "done" && !aborted) folder.transferred++;
      if (aborted) this.closeFolder(folder, { state: "cancelled" });
      else if (code !== undefined && SESSION_ERRORS.has(code)) {
        // The connection is gone: drop the rest of the folder instead of failing every file.
        this.pending = this.pending.filter(entry => entry.folder !== folder);
        this.closeFolder(folder, { state: "failed", reason: error ?? code });
      } else if (folder.processed >= folder.total) this.closeFolder(folder, { state: "done" });
      return;
    }
    if (outcome === "expanded") return;
    const dir = job.kind === "upload" || job.kind === "uploadFolder" ? job.remoteDir : parentPath(job.remotePath);
    this.notify({ sessionId: job.sessionId, dir, kind: direction(job), ...(error === undefined ? {} : { error }), ...(aborted ? { cancelled: true } : {}) });
  }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let entry: Entry | undefined;
      while ((entry = this.pending.shift()) !== undefined) {
        const active: Active = { ...entry, controller: new AbortController(), text: t("transfer.preparing") };
        this.active = active;
        this.emit();
        let error: string | undefined;
        let code: string | undefined;
        let outcome: Outcome = "done";
        try { outcome = await this.execute(active); }
        catch (reason: unknown) {
          if (!active.controller.signal.aborted) {
            error = backendErrorText(reason);
            code = errorCode(reason);
            this.dependencies.report(error);
          }
        }
        await active.cancellation;
        this.settle(active, outcome, error, code);
        this.active = null;
        this.emit();
      }
    } finally { this.running = false; }
  }
}
