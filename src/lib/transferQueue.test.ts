import { describe, expect, it, vi } from "vitest";
import { TransferQueue, type ConflictResolution, type QueueState, type TransferJob, type TreeListing } from "./transferQueue";
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
  const attempts: { name: string; target: string; overwrite: boolean; id: number; channel: Channel; work: ReturnType<typeof deferred<void>> }[] = [];
  const start = (name: string, target: string, overwrite: boolean, transferId: number, channel: Channel) => {
    const work = deferred<void>();
    attempts.push({ name, target, overwrite, id: transferId, channel, work });
    return work.promise;
  };
  const emptyTree: TreeListing = { dirs: [], files: [], skippedSymlinks: 0, skippedOther: 0, skippedInvalid: 0 };
  const listRemoteTree = vi.fn<(sessionId: number, path: string, transferId: number) => Promise<TreeListing>>().mockResolvedValue(emptyTree);
  const listLocalTree = vi.fn<(path: string, transferId: number) => Promise<TreeListing>>().mockResolvedValue(emptyTree);
  const created: string[] = [];
  const ensureRemoteDir = vi.fn((_session: number, path: string) => { created.push(`remote:${path}`); return Promise.resolve(); });
  const ensureLocalDir = vi.fn((path: string) => { created.push(`local:${path}`); return Promise.resolve(); });
  const conflict = vi.fn< (name: string, signal: AbortSignal) => Promise<ConflictResolution> >().mockResolvedValue("skip");
  const cancel = vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined);
  const report = vi.fn<(message: string) => void>();
  const queue = new TransferQueue<Channel>({
    download: (_session, remotePath, localPath, overwrite, transferId, channel) => start(remotePath, localPath, overwrite, transferId, channel),
    upload: (_session, localPath, remoteDir, overwrite, transferId, channel) => start(localPath, remoteDir, overwrite, transferId, channel),
    cancel, allocateId: () => ++id, createChannel: update => update, resolveConflict: conflict, report,
    listRemoteTree, listLocalTree, ensureRemoteDir, ensureLocalDir, localSeparator: () => "\\",
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
  return { queue, attempts, attempt, conflict, cancel, report, states, finished, listRemoteTree, listLocalTree, created };
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
    f.attempt(0).work.reject(`EXISTS: ${JSON.stringify({ args: { name: "a" } })}`); await tick();
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
    f.attempt(0).work.reject(`EXISTS: ${JSON.stringify({ args: { name: "a" } })}`); await tick();
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
    f.attempt(1).work.reject("disk full"); await tick();
    expect(f.report).toHaveBeenCalledWith("disk full");
    f.attempt(2).work.resolve(); await tick();
  });
  it("honors explicit overwrite and unsubscribes status and completion listeners", async () => {
    const f = setup(); const status = vi.fn(); const done = vi.fn();
    const stopStatus = f.queue.subscribe(status); const stopDone = f.queue.onFinished(done);
    stopStatus(); stopDone(); f.queue.enqueue([{ kind: "upload", sessionId: 1, localPath: "/local/a", remoteDir: "/remote", overwrite: true }]);
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
  f.attempt(0).work.reject(`EXISTS: ${JSON.stringify({ args: { name: "a" } })}`); await tick();
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
  f.attempt(0).work.reject(`EXISTS: ${JSON.stringify({ args: { name: "a" } })}`); await tick();
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

it("counts active and pending transfers by session and excludes cancellation", async () => {
  const f = setup();
  f.queue.enqueue([upload("a", 1), download("b", 1), upload("c", 2)]);
  expect(f.queue.countSession(1)).toBe(2);
  expect(f.queue.countSession(2)).toBe(1);
  expect(f.queue.countSession(3)).toBe(0);
  f.queue.cancelSession(1);
  expect(f.queue.countSession(1)).toBe(0);
  f.attempt(0).work.resolve(); await tick();
  expect(f.queue.countSession(2)).toBe(1);
  f.attempt(1).work.resolve(); await tick();
  expect(f.queue.countSession(2)).toBe(0);
});

describe("folder transfers", () => {
  const tree = (files: string[], dirs: string[] = [], skippedSymlinks = 0, skippedInvalid = 0): TreeListing => ({ dirs, files: files.map(path => ({ path, size: 1, executable: false })), skippedSymlinks, skippedOther: 0, skippedInvalid });
  const uploadFolder = (sessionId = 1): TransferJob => ({ kind: "uploadFolder", sessionId, localPath: "C:\\data\\logs", remoteDir: "/srv" });
  const downloadFolder = (sessionId = 1): TransferJob => ({ kind: "downloadFolder", sessionId, remotePath: "/var/logs", localParent: "C:\\Users\\a\\" });

  it("creates folders parent-first and then queues one upload per file", async () => {
    const f = setup(); f.listLocalTree.mockResolvedValue(tree(["a.txt", "sub/b.txt", "sub/deep/c.txt"], ["sub", "sub/deep"], 2));
    f.queue.enqueue([uploadFolder()]); f.queue.enqueue([upload("later")]); await tick();
    expect(f.listLocalTree).toHaveBeenCalledWith("C:\\data\\logs", expect.any(Number));
    expect(f.created).toEqual(["remote:/srv/logs", "remote:/srv/logs/sub", "remote:/srv/logs/sub/deep"]);
    expect(f.attempts.map(item => [item.name, item.target, item.overwrite])).toEqual([["C:\\data\\logs\\a.txt", "/srv/logs", false]]);
    expect(f.states[f.states.length - 1]?.queued).toBe(3);
    for (let index = 0; index < 3; index++) { f.attempt(index).work.resolve(); await tick(); }
    expect(f.attempts.slice(1, 3).map(item => [item.name, item.target])).toEqual([["C:\\data\\logs\\sub\\b.txt", "/srv/logs/sub"], ["C:\\data\\logs\\sub\\deep\\c.txt", "/srv/logs/sub/deep"]]);
    expect(f.attempt(3).name).toBe("/local/later");
    // One completion event for the whole folder, with the skipped links in the summary.
    expect(f.finished.mock.calls[0]?.[0]).toEqual({ sessionId: 1, dir: "/srv", kind: "upload", summary: "Ordner logs hochgeladen: 3 von 3 Dateien, 2 symbolische Links übersprungen" });
    f.attempt(3).work.resolve(); await tick();
    expect(f.finished).toHaveBeenCalledTimes(2);
  });

  it("downloads into a folder of the same name inside the chosen local folder", async () => {
    const f = setup(); f.listRemoteTree.mockResolvedValue(tree(["old/y.log", "x.log"], ["old"]));
    f.queue.enqueue([downloadFolder()]); await tick();
    expect(f.listRemoteTree).toHaveBeenCalledWith(1, "/var/logs", expect.any(Number));
    expect(f.created).toEqual(["local:C:\\Users\\a\\logs", "local:C:\\Users\\a\\logs\\old"]);
    expect([f.attempt(0).name, f.attempt(0).target, f.attempt(0).overwrite]).toEqual(["/var/logs/old/y.log", "C:\\Users\\a\\logs\\old\\y.log", false]);
    f.attempt(0).work.resolve(); await tick();
    f.attempt(1).work.resolve(); await tick();
    expect(f.finished.mock.calls.map(call => call[0])).toEqual([{ sessionId: 1, dir: "/var", kind: "download", summary: "Ordner logs heruntergeladen: 2 von 2 Dateien" }]);
  });

  it("shows the folder position next to the file progress", async () => {
    const f = setup(); f.listLocalTree.mockResolvedValue(tree(["a", "b"]));
    f.queue.enqueue([uploadFolder()]); await tick();
    f.attempt(0).channel({ transferId: 2, done: 50, total: 100 });
    expect(f.states[f.states.length - 1]?.text).toMatch(/^Ordner logs: 1 von 2 Dateien · ↑ a 50 %/);
    f.attempt(0).work.resolve(); await tick();
    expect(f.states[f.states.length - 1]?.text).toMatch(/^Ordner logs: 2 von 2 Dateien · ↑ b/);
    f.attempt(1).work.resolve(); await tick();
  });

  it("asks per file and applies overwrite all to the rest of the folder", async () => {
    const f = setup(); f.listRemoteTree.mockResolvedValue(tree(["a", "b", "c"])); f.conflict.mockResolvedValueOnce("skip").mockResolvedValueOnce("overwriteAll");
    f.queue.enqueue([downloadFolder()]); await tick();
    f.attempt(0).work.reject(`EXISTS: ${JSON.stringify({ args: { name: "a" } })}`); await tick();
    expect(f.conflict).toHaveBeenLastCalledWith("a", expect.any(AbortSignal));
    expect([f.attempt(1).name, f.attempt(1).overwrite]).toEqual(["/var/logs/b", false]);
    f.attempt(1).work.reject(`EXISTS: ${JSON.stringify({ args: { name: "b" } })}`); await tick();
    expect([f.attempt(2).name, f.attempt(2).overwrite]).toEqual(["/var/logs/b", true]);
    f.attempt(2).work.resolve(); await tick();
    expect([f.attempt(3).name, f.attempt(3).overwrite]).toEqual(["/var/logs/c", true]);
    f.attempt(3).work.resolve(); await tick();
    expect(f.conflict).toHaveBeenCalledTimes(2);
    expect(f.finished.mock.calls[0]?.[0].summary).toBe("Ordner logs heruntergeladen: 2 von 3 Dateien");
  });

  it("cancel stops the remaining files of the folder and reports one cancellation", async () => {
    const f = setup(); f.listLocalTree.mockResolvedValue(tree(["a", "b", "c"]));
    f.queue.enqueue([uploadFolder()]); f.queue.enqueue([download("later")]); await tick();
    expect(f.states[f.states.length - 1]?.queued).toBe(3);
    f.queue.cancelCurrent();
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.states[f.states.length - 1]?.queued).toBe(1);
    f.attempt(0).work.reject("CANCELLED"); await tick();
    expect(f.attempt(1).name).toBe("/remote/later");
    expect(f.finished.mock.calls.map(call => call[0])).toEqual([{ sessionId: 1, dir: "/srv", kind: "upload", cancelled: true, summary: "Ordner logs abgebrochen: 0 von 3 Dateien übertragen" }]);
    expect(f.report).not.toHaveBeenCalled();
    f.attempt(1).work.resolve(); await tick();
  });

  it("cancel from the conflict question stops the folder", async () => {
    const f = setup(); f.listLocalTree.mockResolvedValue(tree(["a", "b"])); f.conflict.mockResolvedValue("cancel");
    f.queue.enqueue([uploadFolder()]); await tick();
    f.attempt(0).work.reject(`EXISTS: ${JSON.stringify({ args: { name: "a" } })}`); await tick();
    expect(f.attempts).toHaveLength(1);
    expect(f.finished.mock.calls.map(call => call[0])).toEqual([{ sessionId: 1, dir: "/srv", kind: "upload", cancelled: true, summary: "Ordner logs abgebrochen: 0 von 2 Dateien übertragen" }]);
  });

  it("continues after a failed file and counts it in the summary", async () => {
    const f = setup(); f.listLocalTree.mockResolvedValue(tree(["a", "b"]));
    f.queue.enqueue([uploadFolder()]); await tick();
    f.attempt(0).work.reject("permission denied"); await tick();
    expect(f.report).toHaveBeenCalledWith("permission denied");
    f.attempt(1).work.resolve(); await tick();
    expect(f.finished.mock.calls[0]?.[0]).toMatchObject({ summary: "Ordner logs hochgeladen: 1 von 2 Dateien, ein Fehler (a)", error: "ein Fehler" });
  });

  it("transfers nothing when the listing fails and reports the reason", async () => {
    const f = setup(); f.listRemoteTree.mockRejectedValue(`TREE_TOO_MANY: ${JSON.stringify({ args: { limit: "10000" } })}`);
    f.queue.enqueue([downloadFolder(), download("next")]); await tick();
    expect(f.created).toEqual([]);
    expect(f.report).toHaveBeenCalledWith("Ordner enthält mehr als 10000 Einträge, nichts übertragen");
    expect(f.attempt(0).name).toBe("/remote/next");
    expect(f.finished.mock.calls[0]?.[0]).toMatchObject({ kind: "download", dir: "/var", error: expect.any(String) });
    f.attempt(0).work.resolve(); await tick();
  });

  it("finishes an empty folder right after creating it", async () => {
    const f = setup();
    f.queue.enqueue([uploadFolder()]); await tick();
    expect(f.created).toEqual(["remote:/srv/logs"]);
    expect(f.finished.mock.calls[0]?.[0].summary).toBe("Ordner logs hochgeladen: 0 von 0 Dateien");
    expect(f.states[f.states.length - 1]).toBeNull();
  });

  it("expands a dropped folder that the backend reports as a directory", async () => {
    const f = setup(); f.listLocalTree.mockResolvedValue(tree(["inner.txt"]));
    f.queue.enqueue([{ kind: "upload", sessionId: 1, localPath: "/home/a/photos", remoteDir: "/srv" }]);
    f.attempt(0).work.reject("DIRECTORY"); await tick();
    expect(f.listLocalTree).toHaveBeenCalledWith("/home/a/photos", expect.any(Number));
    expect(f.created).toEqual(["remote:/srv/photos"]);
    expect([f.attempt(1).name, f.attempt(1).target]).toEqual(["/home/a/photos\\inner.txt", "/srv/photos"]);
    f.attempt(1).work.resolve(); await tick();
    expect(f.report).not.toHaveBeenCalled();
  });

  it("closing a session ends its folder but keeps other sessions", async () => {
    const f = setup(); f.listLocalTree.mockResolvedValue(tree(["a", "b"]));
    f.queue.enqueue([uploadFolder(1)]); f.queue.enqueue([upload("keep", 2)]); await tick();
    expect(f.queue.countSession(1)).toBe(2);
    f.queue.cancelSession(1);
    expect(f.queue.countSession(1)).toBe(0);
    f.attempt(0).work.reject("CANCELLED"); await tick();
    expect(f.finished.mock.calls.map(call => call[0])).toEqual([{ sessionId: 1, dir: "/srv", kind: "upload", cancelled: true, summary: "Ordner logs abgebrochen: 0 von 2 Dateien übertragen" }]);
    expect(f.attempt(1).name).toBe("/local/keep");
    f.attempt(1).work.resolve(); await tick();
  });
  it("cancel while listing stops the backend listing and frees the queue at once", async () => {
    const f = setup(); const listing = deferred<TreeListing>(); f.listRemoteTree.mockReturnValue(listing.promise);
    f.queue.enqueue([downloadFolder()]); f.queue.enqueue([upload("next")]); await tick();
    expect(f.listRemoteTree).toHaveBeenCalledWith(1, "/var/logs", 1);
    expect(f.states[f.states.length - 1]?.text).toBe("Ordner logs wird gelesen…");
    f.queue.cancelCurrent(); await tick();
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.attempt(0).name).toBe("/local/next");
    expect(f.finished.mock.calls[0]?.[0]).toEqual({ sessionId: 1, dir: "/var", kind: "download", cancelled: true });
    listing.reject("CANCELLED"); await tick();
    expect(f.created).toEqual([]);
    expect(f.report).not.toHaveBeenCalled();
    f.attempt(0).work.resolve(); await tick();
  });

  it("names the first five failed files and counts the rest", async () => {
    const f = setup(); f.listLocalTree.mockResolvedValue(tree(["a", "b", "c", "sub/d", "sub/e", "sub/f", "g"], ["sub"]));
    f.queue.enqueue([uploadFolder()]); await tick();
    for (let index = 0; index < 6; index++) { f.attempt(index).work.reject("permission denied"); await tick(); }
    f.attempt(6).work.resolve(); await tick();
    expect(f.finished.mock.calls[0]?.[0].summary).toBe("Ordner logs hochgeladen: 1 von 7 Dateien, 6 Fehler (a, b, c, sub/d, sub/e, 1 weitere)");
  });

  it("drops the rest of the folder after a lost connection instead of failing every file", async () => {
    const f = setup(); f.listLocalTree.mockResolvedValue(tree(["a", "b", "c"]));
    f.queue.enqueue([uploadFolder()]); f.queue.enqueue([download("other")]); await tick();
    f.attempt(0).work.resolve(); await tick();
    f.attempt(1).work.reject(`SFTP_CLOSED: ${JSON.stringify({ detail: "SendError" })}`); await tick();
    expect(f.report).toHaveBeenCalledTimes(1);
    expect(f.attempt(2).name).toBe("/remote/other");
    expect(f.finished.mock.calls[0]?.[0]).toMatchObject({ sessionId: 1, dir: "/srv", kind: "upload", summary: expect.stringMatching(/^Ordner logs abgebrochen \(SFTP-Verbindung geschlossen.*\): 1 von 3 Dateien übertragen, ein Fehler \(b\)$/) });
    f.attempt(2).work.resolve(); await tick();
  });

  it("reports the partial result when cancelled in the middle", async () => {
    const f = setup(); f.listLocalTree.mockResolvedValue(tree(["a", "b", "c", "d"]));
    f.queue.enqueue([uploadFolder()]); await tick();
    f.attempt(0).work.resolve(); await tick();
    f.attempt(1).work.resolve(); await tick();
    f.queue.cancelCurrent(); f.attempt(2).work.reject("CANCELLED"); await tick();
    expect(f.finished.mock.calls[0]?.[0]).toEqual({ sessionId: 1, dir: "/srv", kind: "upload", cancelled: true, summary: "Ordner logs abgebrochen: 2 von 4 Dateien übertragen" });
  });

  it("mentions entries skipped for unusable names", async () => {
    const f = setup(); f.listRemoteTree.mockResolvedValue(tree(["a"], [], 0, 3));
    f.queue.enqueue([downloadFolder()]); await tick();
    f.attempt(0).work.resolve(); await tick();
    expect(f.finished.mock.calls[0]?.[0].summary).toBe("Ordner logs heruntergeladen: 1 von 1 Dateien, 3 Einträge mit unzulässigem Namen übersprungen");
  });
});
