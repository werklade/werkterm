import { describe, expect, it, vi } from "vitest";
import { createUiScaler, revertedUiScale, settleWithin } from "./uiScale";

describe("createUiScaler", () => {
  it("sets the zoom factor from the percentage, notifies and remembers the size", async () => {
    const setZoom = vi.fn(() => Promise.resolve());
    const notify = vi.fn();
    const scaler = createUiScaler(setZoom, notify);
    expect(scaler.applied()).toBe(100);
    await scaler.apply(125);
    expect(setZoom).toHaveBeenCalledWith(1.25);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(scaler.applied()).toBe(125);
    await scaler.apply(90);
    expect(setZoom).toHaveBeenLastCalledWith(0.9);
    expect(scaler.applied()).toBe(90);
  });
  it("does not request a size already set or still being set", async () => {
    const setZoom = vi.fn(() => Promise.resolve());
    const scaler = createUiScaler(setZoom, () => {});
    await scaler.apply(100);
    expect(setZoom).not.toHaveBeenCalled();
    await Promise.all([scaler.apply(110), scaler.apply(110)]);
    await scaler.apply(110);
    expect(setZoom).toHaveBeenCalledTimes(1);
    await scaler.apply(100); await scaler.apply(110);
    expect(setZoom).toHaveBeenCalledTimes(3);
  });
  it("rejects on failure, keeps the last size and tries again on every later call", async () => {
    const setZoom = vi.fn().mockRejectedValueOnce(new Error("not allowed")).mockRejectedValueOnce(new Error("again")).mockResolvedValue(undefined);
    const notify = vi.fn();
    const scaler = createUiScaler(setZoom, notify);
    await expect(scaler.apply(150)).rejects.toThrow("not allowed");
    expect(scaler.applied()).toBe(100);
    await expect(scaler.apply(150)).rejects.toThrow("again");
    expect(notify).not.toHaveBeenCalled();
    await scaler.apply(150);
    expect(setZoom).toHaveBeenCalledTimes(3);
    expect(scaler.applied()).toBe(150);
  });
  it("lets a second caller share a running request and see its error", async () => {
    let fail: (reason: Error) => void = () => {};
    const setZoom = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
    const scaler = createUiScaler(setZoom, () => {});
    const early = scaler.apply(125);
    const later = scaler.apply(125);
    await Promise.resolve(); fail(new Error("no webview"));
    await expect(early).rejects.toThrow("no webview");
    await expect(later).rejects.toThrow("no webview");
    expect(setZoom).toHaveBeenCalledTimes(1);
  });
  it("turns a synchronous error of the webview call into a rejection", async () => {
    const scaler = createUiScaler(() => { throw new Error("no webview"); }, () => {});
    await expect(scaler.apply(90)).rejects.toThrow("no webview");
  });
});

describe("revertedUiScale", () => {
  it("returns the setting to the size actually shown after a failed change", () => {
    expect(revertedUiScale(125, 125, 100)).toBe(100);
    expect(revertedUiScale(90, 90, 110)).toBe(110);
  });
  it("leaves a setting alone that already moved on or matches the shown size", () => {
    expect(revertedUiScale(125, 150, 100)).toBeNull();
    expect(revertedUiScale(100, 100, 100)).toBeNull();
  });
});

describe("settleWithin", () => {
  it("resolves when the promise settles, also on rejection", async () => {
    await expect(settleWithin(Promise.resolve(1), 1000)).resolves.toBeUndefined();
    await expect(settleWithin(Promise.reject(new Error("x")), 1000)).resolves.toBeUndefined();
  });
  it("resolves after the timeout if the promise is still running", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const waiting = settleWithin(new Promise(() => {}), 300).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(299);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(done).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
