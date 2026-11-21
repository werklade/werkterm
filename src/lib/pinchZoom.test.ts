import { describe, expect, it, vi } from "vitest";
import { createPinchRouter, focusedPinchTarget, PINCH_STEP_RATIO, pinchLevel, pinchSteps, initialPinch, type PinchPayload, type PinchTarget } from "./pinchZoom";

const update = (scale: number): PinchPayload => ({ phase: "update", scale });
const begin: PinchPayload = { phase: "begin", scale: 1 };
const end = (): PinchPayload => ({ phase: "end", scale: 1 });

function target(owns: Element[]) {
  return { element: { contains: (node: Node | null) => owns.includes(node as Element) }, zoomBy: vi.fn<(steps: number) => void>() } satisfies PinchTarget;
}
const node = (name: string) => ({ name }) as unknown as Element;

describe("pinchLevel", () => {
  it("counts whole steps of the ratio, toward 1.0", () => {
    expect(pinchLevel(1)).toBe(0);
    expect(pinchLevel(1.09)).toBe(0);
    expect(pinchLevel(PINCH_STEP_RATIO + 0.001)).toBe(1);
    expect(pinchLevel(PINCH_STEP_RATIO ** 3 + 0.001)).toBe(3);
    expect(pinchLevel(1 / PINCH_STEP_RATIO - 0.001)).toBe(-1);
    expect(pinchLevel(0.95)).toBe(0);
    expect(Object.is(pinchLevel(0.95), -0)).toBe(false);
  });
  it("ignores unusable scales", () => {
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(pinchLevel(scale)).toBe(0);
  });
});

describe("pinchSteps", () => {
  it("returns the steps since the last event, both ways", () => {
    let result = pinchSteps(initialPinch, update(1.25));
    expect(result.steps).toBe(2);
    result = pinchSteps(result.state, update(1.3));
    expect(result.steps).toBe(0);
    result = pinchSteps(result.state, update(0.85));
    expect(result.steps).toBe(-3);
  });
  it("resets on begin and end", () => {
    expect(pinchSteps({ level: 4 }, begin)).toEqual({ state: initialPinch, steps: 0 });
    expect(pinchSteps({ level: 4 }, end())).toEqual({ state: initialPinch, steps: 0 });
  });
});

describe("focusedPinchTarget", () => {
  it("picks the terminal or editor holding the focus, or nothing", () => {
    const inside = node("textarea"); const other = node("button");
    const terminal = target([inside]); const editor = target([]);
    expect(focusedPinchTarget([editor, terminal], inside)).toBe(terminal);
    expect(focusedPinchTarget([editor, terminal], other)).toBeNull();
    expect(focusedPinchTarget([editor, terminal], null)).toBeNull();
  });
});

describe("createPinchRouter", () => {
  it("zooms the target focused at the start of the gesture by the pinch steps", () => {
    const focus = node("terminal-input"); const terminal = target([focus]); const editor = target([]);
    let active: Element | null = focus;
    const router = createPinchRouter(() => [terminal, editor], () => active);
    router.handle(begin);
    active = null; // focus moving mid-gesture does not switch the target
    router.handle(update(1.11)); router.handle(update(1.25)); router.handle(update(1.0));
    router.handle(end());
    expect(terminal.zoomBy.mock.calls).toEqual([[1], [1], [-2]]);
    expect(editor.zoomBy).not.toHaveBeenCalled();
  });
  it("does nothing outside a terminal or editor", () => {
    const terminal = target([]);
    const router = createPinchRouter(() => [terminal], () => node("sidebar"));
    router.handle(begin); router.handle(update(2)); router.handle(end());
    expect(terminal.zoomBy).not.toHaveBeenCalled();
  });
  it("stops zooming a target that was unregistered mid-gesture", () => {
    const focus = node("terminal"); const terminal = target([focus]);
    let registered: PinchTarget[] = [terminal];
    const router = createPinchRouter(() => registered, () => focus);
    router.handle(begin); router.handle(update(1.11));
    registered = [];
    router.handle(update(1.5)); router.handle(end());
    expect(terminal.zoomBy.mock.calls).toEqual([[1]]);
  });
  it("starts without a jump on an update that arrives without a begin", () => {
    const focus = node("editor"); const editor = target([focus]);
    const router = createPinchRouter(() => [editor], () => focus);
    router.handle(update(1.5));
    expect(editor.zoomBy).not.toHaveBeenCalled();
    router.handle(update(1.5 * PINCH_STEP_RATIO + 0.01));
    expect(editor.zoomBy.mock.calls).toEqual([[1]]);
  });
  it("starts every gesture afresh", () => {
    const focus = node("terminal"); const terminal = target([focus]);
    const router = createPinchRouter(() => [terminal], () => focus);
    router.handle(begin); router.handle(update(1.25)); router.handle(end());
    router.handle(begin); router.handle(update(1.25)); router.handle(end());
    expect(terminal.zoomBy.mock.calls).toEqual([[2], [2]]);
  });
});
