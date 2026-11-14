import { backendErrorText, localFileName, transferText, type TransferProgress } from "./transferFormat";
import { errorCode } from "./backendError";
import { t } from "../i18n";
import { parentPath } from "./paths";

export type TransferJob =
  | { kind: "download"; sessionId: number; remotePath: string; localPath: string }
  | { kind: "upload"; sessionId: number; localPath: string; remoteDir: string; overwrite?: boolean };
export type ConflictResolution = "overwrite" | "skip" | "overwriteAll" | "cancel";
export type QueueState = { text: string; queued: number } | null;
export interface TransferFinished { sessionId: number; dir: string; kind: TransferJob["kind"]; error?: string; cancelled?: boolean }
export interface TransferDependencies<C> {
  download: (sessionId: number, remotePath: string, localPath: string, transferId: number, channel: C) => Promise<void>;
  upload: (sessionId: number, localPath: string, remoteDir: string, overwrite: boolean, transferId: number, channel: C) => Promise<void>;
  cancel: (transferId: number) => Promise<void>;
  allocateId: () => number;
  createChannel: (update: (progress: TransferProgress) => void) => C;
  resolveConflict: (name: string, signal: AbortSignal) => Promise<ConflictResolution>;
  report: (message: string) => void;
}
interface Batch { overwriteAll: boolean }
interface Entry { job: TransferJob; batch: Batch }
interface Active extends Entry { controller: AbortController; transferId?: number; text: string; cancellation?: Promise<void> }
export type TransferQueueHandle = Pick<TransferQueue<unknown>, "enqueue" | "onFinished">;

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
  cancelCurrent(): void {
    const active = this.active;
    if (!active || active.controller.signal.aborted) return;
    this.pending = this.pending.filter(entry => entry.batch !== active.batch);
    this.abort(active);
    this.emit();
  }
  /** Session IDs identify a connection; closed sessions also reject late native-dialog selections. */
  cancelSession(sessionId: number): void {
    if (this.cancelledSessions.has(sessionId)) return;
    this.cancelledSessions.add(sessionId);
    this.pending = this.pending.filter(entry => entry.job.sessionId !== sessionId);
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
  private abort(active: Active): void {
    if (active.controller.signal.aborted) return;
    active.controller.abort();
    if (active.transferId !== undefined) {
      active.cancellation = this.dependencies.cancel(active.transferId).catch(reason => {
        this.dependencies.report(t("transfer.cancelFailed", { reason: backendErrorText(reason) }));
      });
    }
  }
  private async transfer(active: Active, overwrite: boolean): Promise<void> {
    if (active.controller.signal.aborted) return;
    const { job } = active;
    const transferId = this.dependencies.allocateId();
    const update = (progress: TransferProgress) => {
      if (this.active !== active || (active.transferId !== transferId || progress.transferId !== transferId) || active.controller.signal.aborted) return;
      active.text = transferText(job.kind === "upload" ? "↑" : "↓", (job.kind === "upload" ? localFileName(job.localPath) : job.remotePath.split("/").pop() ?? job.remotePath), progress);
      this.emit();
    };
    active.text = transferText(job.kind === "upload" ? "↑" : "↓", (job.kind === "upload" ? localFileName(job.localPath) : job.remotePath.split("/").pop() ?? job.remotePath), { transferId, done: 0, total: null });
    this.emit();
    try {
      const channel = this.dependencies.createChannel(update);
      if (active.controller.signal.aborted) return;
      active.transferId = transferId;
      if (job.kind === "download") await this.dependencies.download(job.sessionId, job.remotePath, job.localPath, transferId, channel);
      else await this.dependencies.upload(job.sessionId, job.localPath, job.remoteDir, overwrite, transferId, channel);
    } finally { active.transferId = undefined; }
  }
  private async execute(active: Active): Promise<void> {
    try { await this.transfer(active, active.job.kind === "upload" && (active.job.overwrite === true || active.batch.overwriteAll)); }
    catch (reason: unknown) {
      if (active.controller.signal.aborted) return;
      if (active.job.kind !== "upload" || errorCode(reason) !== "EXISTS") throw reason;
      const signal = active.controller.signal;
      // Cancellation releases the queue even if an injected dialog never answers.
      let stop: () => void = () => undefined;
      const cancelled = new Promise<ConflictResolution>(resolve => {
        stop = () => resolve("cancel");
        signal.addEventListener("abort", stop, { once: true });
      });
      let answer: ConflictResolution;
      try { answer = await Promise.race([cancelled, this.dependencies.resolveConflict(localFileName(active.job.localPath), signal)]); }
      finally { signal.removeEventListener("abort", stop); }
      if (signal.aborted) return;
      if (answer === "cancel") { this.cancelCurrent(); return; }
      if (answer === "skip") return;
      if (answer === "overwriteAll") active.batch.overwriteAll = true;
      await this.transfer(active, true);
    }
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
        try { await this.execute(active); }
        catch (reason: unknown) {
          if (!active.controller.signal.aborted) {
            error = backendErrorText(reason);
            this.dependencies.report(error);
          }
        }
        await active.cancellation;
        const { job } = active;
        const event: TransferFinished = { sessionId: job.sessionId, dir: job.kind === "upload" ? job.remoteDir : parentPath(job.remotePath), kind: job.kind, ...(error === undefined ? {} : { error }), ...(active.controller.signal.aborted ? { cancelled: true } : {}) };
        for (const listener of this.finished) listener(event);
        this.active = null;
        this.emit();
      }
    } finally { this.running = false; }
  }
}
