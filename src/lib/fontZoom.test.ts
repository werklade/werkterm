import { describe, expect, it } from "vitest";
import { accumulateZoomWheel, effectiveFontSize, initialZoomWheel, nextZoomOffset, offsetAfterResetToken, ZOOM_IDLE_MS, ZOOM_STEP_THRESHOLD, type ZoomWheelState } from "./fontZoom";
import { installZoomGuard } from "./zoomGuard";

describe("accumulateZoomWheel", () => {
  it("turns one mouse notch into exactly one step", () => {
    expect(accumulateZoomWheel(initialZoomWheel, -100, 0, 1000).steps).toBe(1);
    expect(accumulateZoomWheel(initialZoomWheel, 100, 0, 1000).steps).toBe(-1);
    expect(accumulateZoomWheel(initialZoomWheel, -3, 1, 1000).steps).toBe(1);
  });
  it("sums small touchpad deltas until the threshold, then starts over", () => {
    let state: ZoomWheelState = initialZoomWheel;
    const steps: number[] = [];
    for (let i = 0; i < 12; i++) {
      const result = accumulateZoomWheel(state, -5, 0, 1000 + i * 16);
      state = result.state; steps.push(result.steps);
    }
    expect(steps.reduce((a, b) => a + b, 0)).toBe(1);
    expect(steps.indexOf(1)).toBe(Math.ceil(ZOOM_STEP_THRESHOLD / 5) - 1);
    expect(state.acc).toBeCloseTo(-5 * (12 - Math.ceil(ZOOM_STEP_THRESHOLD / 5)));
  });
  it("drops the sum after a pause or direction change and ignores zero or invalid deltas", () => {
    const partial = accumulateZoomWheel(initialZoomWheel, -30, 0, 1000).state;
    expect(accumulateZoomWheel(partial, -30, 0, 1000 + ZOOM_IDLE_MS + 1).steps).toBe(0);
    expect(accumulateZoomWheel(partial, 30, 0, 1010).steps).toBe(0);
    expect(accumulateZoomWheel(partial, -30, 0, 1010).steps).toBe(1);
    expect(accumulateZoomWheel(partial, 0, 0, 1010)).toEqual({ state: partial, steps: 0 });
    expect(accumulateZoomWheel(partial, NaN, 0, 1010).steps).toBe(0);
  });
});

describe("font offset", () => {
  it("clamps to 8 and 32", () => {
    expect(nextZoomOffset(14, 0, 1)).toBe(1);
    expect(nextZoomOffset(14, 0, -1)).toBe(-1);
    expect(effectiveFontSize(14, nextZoomOffset(14, 18, 1))).toBe(32);
    expect(nextZoomOffset(14, 18, 1)).toBe(18);
    expect(effectiveFontSize(14, nextZoomOffset(14, -6, -1))).toBe(8);
    expect(nextZoomOffset(14, -6, -1)).toBe(-6);
  });
  it("keeps the offset when the base size changes and clamps the result", () => {
    const offset = nextZoomOffset(14, 0, 2);
    expect(effectiveFontSize(20, offset)).toBe(22);
    expect(effectiveFontSize(31, offset)).toBe(32);
    expect(effectiveFontSize(9, -5)).toBe(8);
  });
  it("steps from the clamped size when the base moved past the limit", () => {
    expect(effectiveFontSize(30, nextZoomOffset(30, 6, -1))).toBe(31);
  });
  it("resets with offset 0", () => {
    expect(effectiveFontSize(14, 0)).toBe(14);
    expect(effectiveFontSize(40, 0)).toBe(32);
  });
});

describe("offsetAfterResetToken", () => {
  it("drops the offset only when the token changed", () => {
    expect(offsetAfterResetToken(0, 0, 3)).toEqual({ seen: 0, offset: 3 });
    expect(offsetAfterResetToken(0, 1, 3)).toEqual({ seen: 1, offset: 0 });
    expect(offsetAfterResetToken(1, 1, -2)).toEqual({ seen: 1, offset: -2 });
  });
});

describe("installZoomGuard", () => {
  const fire = (target: EventTarget, type: string, props: object = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), props);
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  it("blocks ctrl+wheel and gestures but not plain scrolling", () => {
    const target = new EventTarget();
    const remove = installZoomGuard(target);
    expect(fire(target, "wheel", { ctrlKey: true })).toBe(true);
    expect(fire(target, "wheel", { ctrlKey: false })).toBe(false);
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) expect(fire(target, type)).toBe(true);
    remove();
    expect(fire(target, "wheel", { ctrlKey: true })).toBe(false);
    expect(fire(target, "gesturestart")).toBe(false);
  });
});
