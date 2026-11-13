export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
/** Normalized wheel distance (px) that triggers one step. */
export const ZOOM_STEP_THRESHOLD = 40;
/** A pause longer than this ends a gesture; the accumulated distance is dropped. */
export const ZOOM_IDLE_MS = 250;

export interface ZoomWheelState { acc: number; time: number }
export const initialZoomWheel: ZoomWheelState = { acc: 0, time: 0 };

export function clampFontSize(size: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
}

/** Font size actually used: base setting plus per-tab offset, clamped. */
export function effectiveFontSize(base: number, offset: number): number {
  return clampFontSize(base + offset);
}

/** Applies a "reset font" token: a new token value drops the offset, an unchanged one keeps it. */
export function offsetAfterResetToken(seen: number, token: number, offset: number): { seen: number; offset: number } {
  return token === seen ? { seen, offset } : { seen: token, offset: 0 };
}

/** New offset after `steps` (+1 larger, -1 smaller); never leaves the allowed size range. */
export function nextZoomOffset(base: number, offset: number, steps: number): number {
  return clampFontSize(effectiveFontSize(base, offset) + steps) - base;
}

/**
 * Sums wheel deltas (ctrl+wheel or pinch gesture) and returns at most one step per call.
 * A single large delta (mouse notch) is exactly one step; small touchpad deltas add up
 * until they reach the threshold. Wheel up (negative deltaY) means larger.
 */
export function accumulateZoomWheel(state: ZoomWheelState, deltaY: number, deltaMode: number, time: number): { state: ZoomWheelState; steps: -1 | 0 | 1 } {
  const delta = deltaMode === 1 ? deltaY * ZOOM_STEP_THRESHOLD : deltaMode === 2 ? deltaY * ZOOM_STEP_THRESHOLD * 10 : deltaY;
  if (!Number.isFinite(delta) || delta === 0) return { state, steps: 0 };
  const fresh = time - state.time > ZOOM_IDLE_MS || Math.sign(state.acc) !== Math.sign(delta);
  const sum = (fresh ? 0 : state.acc) + delta;
  if (Math.abs(sum) >= ZOOM_STEP_THRESHOLD) return { state: { acc: 0, time }, steps: sum < 0 ? 1 : -1 };
  return { state: { acc: sum, time }, steps: 0 };
}
