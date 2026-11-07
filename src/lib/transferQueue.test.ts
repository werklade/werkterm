import { describe, expect, it, vi } from "vitest";
import { TransferQueue, type ConflictResolution, type QueueState, type TransferJob } from "./transferQueue";
import type { TransferProgress } from "./transferFormat";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
type Channel = (progress: TransferProgress) => void;
const upload = (name: string, sessionId = 1): TransferJob => ({ kind: "upload", sessionId, localPath: `/local/${name}`, remoteDir: "/remote" });
const download = (name: string, sessionId = 1): TransferJob => ({ kind: "download", sessionId, remotePath: `/remote/${name}`, localPath: `/local/${name}` });
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function setup() {
  let id = 0;
  const attempts: { name: string; overwrite: boolean; id: number; channel: Channel; work: ReturnType<typeof deferred<void>> }[] = [];
  const start = (name: string, overwrite: boolean, transferId: number, channel: Channel) => {
    const work = deferred<void>();
    attempts.push({ name, overwrite, id: transferId, channel, work });
    return work.promise;
  };
  const conflict = vi.fn< (name: string, signal: AbortSignal) => Promise<ConflictResolution> >().mockResolvedValue("skip");
  const cancel = vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined);
  const report = vi.fn<(message: string) => void>();
  const queue = new TransferQueue<Channel>({
    download: (_session, remotePath, _local, transferId, channel) => start(remotePath, false, transferId, channel),
    upload: (_session, localPath, _remote, overwrite, transferId, channel) => start(localPath, overwrite, transferId, channel),
    cancel, allocateId: () => ++id, createChannel: update => update, resolveConflict: conflict, report,
  });
  const states: QueueState[] = [];
  queue.subscribe(state => states.push(state));
  const finished = vi.fn();
  queue.onFinished(finished);
  const attempt = (index: number) => {
    const value = attempts[index];
    if (!value) throw new Error(`Missing attempt ${index}`);
    return value;
  };
  return { queue, attempts, attempt, conflict, cancel, report, states, finished };
}

describe("TransferQueue", () => {
  it("runs uploads and downloads strictly in enqueue order and counts pending jobs", async () => {
    const f = setup();
    f.queue.enqueue([upload("a"), download("b")]);
    f.queue.enqueue([upload("c")]);
    expect(f.attempts).toHaveLength(1);
    expect(f.states[f.states.length - 1]?.queued).toBe(2);
    f.attempt(0).channel({ transferId: 1, done: 45, total: 100 });
    expect(f.states[f.states.length - 1]?.text).toContain("45 %");
    f.attempt(0).work.resolve(); await tick();
    expect(f.attempt(1).name).toBe("/remote/b");
    expect(f.states[f.states.length - 1]?.queued).toBe(1);
    f.attempt(1).work.resolve(); await tick();
    expect(f.attempt(2).name).toBe("/local/c");
    expect(f.states[f.states.length - 1]?.queued).toBe(0);
    f.attempt(2).work.resolve(); await tick();
    expect(f.states[f.states.length - 1]).toBeNull();
    expect(f.finished.mock.calls.map(call => call[0])).toEqual([
      { sessionId: 1, dir: "/remote", kind: "upload" },
      { sessionId: 1, dir: "/remote", kind: "download" },
      { sessionId: 1, dir: "/remote", kind: "upload" },
    ]);
  });
  it.each(["overwrite", "skip", "overwriteAll", "cancel"] as const)("handles conflict answer %s", async answer => {
    const f = setup(); f.conflict.mockResolvedValue(answer);
    f.queue.enqueue([upload("a"), upload("b")]);
    f.queue.enqueue([upload("later")]);
    f.attempt(0).work.reject("EXISTS:a"); await tick();
    expect(f.conflict).toHaveBeenCalledWith("a", expect.any(AbortSignal));
    if (answer === "overwrite" || answer === "overwriteAll") {
      expect(f.attempt(1).overwrite).toBe(true);
      f.attempt(1).work.resolve(); await tick();
      expect(f.attempt(2).name).toBe("/local/b");
      expect(f.attempt(2).overwrite).toBe(answer === "overwriteAll");
      f.attempt(2).work.resolve(); await tick();
      expect(f.attempt(3).overwrite).toBe(false);
      f.attempt(3).work.resolve();
    } else {
      expect(f.attempt(1).name).toBe(answer === "cancel" ? "/local/later" : "/local/b");
      f.attempt(1).work.resolve(); await tick();
      if (answer === "skip") f.attempt(2).work.resolve();
    }
    await tick(); expect(f.report).not.toHaveBeenCalled();
  });
  it("cancels the current batch without starting later work before the backend settles", async () => {
    const f = setup();
    f.queue.enqueue([upload("a"), upload("discard")]); f.queue.enqueue([download("later")]);
    f.queue.cancelCurrent(); f.queue.cancelCurrent();
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.states[f.states.length - 1]?.queued).toBe(1);
    expect(f.attempts).toHaveLength(1);
    f.attempt(0).work.reject("Transfer abgebrochen"); await tick();
    expect(f.attempt(1).name).toBe("/remote/later");
    expect(f.report).not.toHaveBeenCalled();
    expect(f.finished.mock.calls[0]?.[0]).not.toHaveProperty("error");
    f.attempt(1).work.resolve(); await tick();
  });
  it("waits for cancellation command completion before starting another transfer", async () => {
    const f = setup(); const cancellation = deferred<void>(); f.cancel.mockReturnValue(cancellation.promise);
    f.queue.enqueue([upload("a")]); f.queue.enqueue([upload("b")]);
    f.queue.cancelCurrent(); f.attempt(0).work.resolve(); await tick();
    expect(f.attempts).toHaveLength(1);
    cancellation.resolve(); await tick(); expect(f.attempts).toHaveLength(2);
    f.attempt(1).work.resolve(); await tick();
  });
  it("cancels active and pending session jobs but keeps other sessions in the same batch", async () => {
    const f = setup(); f.queue.enqueue([upload("a"), upload("discard"), download("keep", 2)]);
    f.queue.cancelSession(1); f.queue.enqueue([upload("closed")]);
    expect(f.states[f.states.length - 1]?.queued).toBe(1);
    f.attempt(0).work.reject("cancelled"); await tick();
    expect(f.attempt(1).name).toBe("/remote/keep");
    f.attempt(1).work.resolve(); await tick();
    expect(f.attempts).toHaveLength(2);
    expect(f.report).not.toHaveBeenCalled();
  });
  it("removes only waiting jobs for a session while another session transfers", async () => {
    const f = setup(); f.queue.enqueue([upload("active", 2), upload("discard"), upload("keep", 3)]);
    f.queue.cancelSession(1); expect(f.cancel).not.toHaveBeenCalled();
    f.attempt(0).work.resolve(); await tick(); expect(f.attempt(1).name).toBe("/local/keep");
    f.attempt(1).work.resolve(); await tick();
  });
  it("cancels an unanswered conflict and ignores its late answer", async () => {
    const f = setup(); const answer = deferred<ConflictResolution>(); f.conflict.mockReturnValue(answer.promise);
    f.queue.enqueue([upload("a"), upload("discard")]); f.queue.enqueue([upload("later")]);
    f.attempt(0).work.reject("EXISTS:a"); await tick();
    const signal = f.conflict.mock.calls[0]?.[1];
    f.queue.cancelCurrent(); await tick();
    expect(signal?.aborted).toBe(true); expect(f.attempt(1).name).toBe("/local/later");
    answer.resolve("overwriteAll"); await tick(); expect(f.attempts).toHaveLength(2);
    f.attempt(1).work.resolve(); await tick(); expect(f.report).not.toHaveBeenCalled();
  });
  it("reports failures with completion metadata and continues subsequent jobs", async () => {
    const f = setup(); f.queue.enqueue([download("bad"), upload("directory"), upload("good")]);
    f.attempt(0).work.reject("permission denied"); await tick();
    expect(f.report).toHaveBeenCalledWith("permission denied");
    expect(f.finished).toHaveBeenCalledWith({ sessionId: 1, dir: "/remote", kind: "download", error: "permission denied" });
    f.attempt(1).work.reject("DIRECTORY:folder"); await tick();
    expect(f.report).toHaveBeenCalledWith("Ordner-Upload folgt später");
    f.attempt(2).work.resolve(); await tick();
  });
  it("honors explicit overwrite and unsubscribes status and completion listeners", async () => {
    const f = setup(); const status = vi.fn(); const done = vi.fn();
    const stopStatus = f.queue.subscribe(status); const stopDone = f.queue.onFinished(done);
    stopStatus(); stopDone(); f.queue.enqueue([{ ...upload("a"), kind: "upload", remoteDir: "/remote", overwrite: true }]);
    expect(f.attempt(0).overwrite).toBe(true);
    f.attempt(0).work.resolve(); await tick(); expect(status).toHaveBeenCalledTimes(1); expect(done).not.toHaveBeenCalled();
  });
  it("does not start the backend when a status listener cancels synchronously", async () => {
    const f = setup(); const listener = vi.fn((state: QueueState) => { if (state?.text.startsWith("↑")) f.queue.cancelCurrent(); });
    f.queue.subscribe(listener);
    f.queue.enqueue([upload("cancel")]); await tick();
    expect(f.attempts).toHaveLength(0); expect(f.cancel).not.toHaveBeenCalled();
    expect(listener.mock.calls.length).toBeLessThan(10);
  });
});

it("ignores stale progress while waiting for a conflict and after a job completes", async () => {
  const f = setup(); const answer = deferred<ConflictResolution>(); f.conflict.mockReturnValue(answer.promise);
  f.queue.enqueue([upload("a"), upload("b")]);
  f.attempt(0).work.reject("EXISTS:a"); await tick();
  const previous = f.states[f.states.length - 1]?.text;
  f.attempt(0).channel({ transferId: 1, done: 100, total: 100 });
  expect(f.states[f.states.length - 1]?.text).toBe(previous);
  answer.resolve("skip"); await tick();
  const next = f.states[f.states.length - 1]?.text;
  f.attempt(0).channel({ transferId: 1, done: 100, total: 100 });
  f.attempt(1).channel({ transferId: 999, done: 100, total: 100 });
  expect(f.states[f.states.length - 1]?.text).toBe(next);
  f.attempt(1).work.resolve(); await tick();
});
it("cancels a session during a conflict without discarding other sessions in its batch", async () => {
  const f = setup(); f.conflict.mockReturnValue(new Promise(() => undefined));
  f.queue.enqueue([upload("a"), upload("discard"), upload("keep", 2)]);
  f.attempt(0).work.reject("EXISTS:a"); await tick();
  f.queue.cancelSession(1); await tick();
  expect(f.conflict.mock.calls[0]?.[1].aborted).toBe(true);
  expect(f.attempt(1).name).toBe("/local/keep");
  expect(f.cancel).not.toHaveBeenCalled();
  f.attempt(1).work.resolve(); await tick();
});
it("preserves backslashes in POSIX remote filenames", async () => {
  const f = setup(); f.queue.enqueue([download("a\\b")]);
  expect(f.states[f.states.length - 1]?.text).toContain("a\\b");
  f.attempt(0).work.resolve(); await tick();
});
