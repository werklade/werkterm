import { afterEach, describe, expect, it, vi } from "vitest";
import { createUndoSlot, undoTimeoutMs } from "./undoOffer";

afterEach(() => vi.useRealTimers());

describe("undo offer", () => {
  it("expires after the timeout and runs at most once", () => {
    vi.useFakeTimers();
    const changes: (string | null)[] = [];
    const slot = createUndoSlot(entry => changes.push(entry?.message ?? null));
    const run = vi.fn();
    slot.offer("Moved", run);
    vi.advanceTimersByTime(undoTimeoutMs - 1);
    slot.take();
    slot.take();
    expect(run).toHaveBeenCalledTimes(1);
    expect(changes).toEqual(["Moved", null]);
    slot.offer("Again", run);
    vi.advanceTimersByTime(undoTimeoutMs);
    expect(changes).toEqual(["Moved", null, "Again", null]);
    slot.take();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("replaces an older offer and stops its timer on dispose", () => {
    vi.useFakeTimers();
    const changes: (string | null)[] = [];
    const slot = createUndoSlot(entry => changes.push(entry?.message ?? null));
    const first = vi.fn(); const second = vi.fn();
    slot.offer("First", first);
    vi.advanceTimersByTime(undoTimeoutMs / 2);
    slot.offer("Second", second);
    vi.advanceTimersByTime(undoTimeoutMs / 2 + 1);
    slot.take();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    slot.offer("Third", first);
    slot.dispose();
    vi.advanceTimersByTime(undoTimeoutMs * 2);
    expect(changes[changes.length - 1]).toBe("Third");
    expect(vi.getTimerCount()).toBe(0);
  });
});
