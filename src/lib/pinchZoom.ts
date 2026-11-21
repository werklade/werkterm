import { listen } from "@tauri-apps/api/event";

/** Tauri event from the Linux backend (src-tauri/src/pinch.rs); WebKitGTK sends JS no event for a touchpad pinch. */
export const pinchEvent = "pinch-zoom";

export interface PinchPayload {
  phase: "begin" | "update" | "end";
  /** Scale since the gesture began (1 = unchanged). */
  scale: number;
}

/** Scale factor per font step: fingers 10 % further apart = one size larger. */
export const PINCH_STEP_RATIO = 1.1;

/** Steps already applied in the running gesture. */
export interface PinchState { level: number }
export const initialPinch: PinchState = { level: 0 };

/** Whole steps reached at `scale`, rounded toward 1.0 so a step needs the full ratio. */
export function pinchLevel(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  const level = Math.trunc(Math.log(scale) / Math.log(PINCH_STEP_RATIO));
  return level === 0 ? 0 : level; // no -0
}

/** Steps to apply for one pinch event (+ larger, - smaller); begin and end reset the gesture. */
export function pinchSteps(state: PinchState, payload: PinchPayload): { state: PinchState; steps: number } {
  if (payload.phase !== "update") return { state: initialPinch, steps: 0 };
  const level = pinchLevel(payload.scale);
  return { state: { level }, steps: level - state.level };
}

export interface PinchTarget {
  element: Pick<Element, "contains">;
  zoomBy(steps: number): void;
}

/** The terminal or editor that holds the focus, or null: a pinch elsewhere changes nothing. */
export function focusedPinchTarget(targets: Iterable<PinchTarget>, active: Element | null): PinchTarget | null {
  if (!active) return null;
  let found: PinchTarget | null = null;
  for (const target of targets) if (target.element.contains(active)) found = target;
  return found;
}

export interface PinchRouter {
  handle(payload: PinchPayload): void;
}

/**
 * Routes pinch events: the target is chosen once at the start of the gesture (focused terminal or editor)
 * and gets every step of it while it is still registered. The interface size is never touched.
 */
export function createPinchRouter(targets: () => Iterable<PinchTarget>, active: () => Element | null): PinchRouter {
  let state = initialPinch;
  let target: PinchTarget | null = null;
  let running = false;
  return {
    handle(payload) {
      if (payload.phase === "begin") {
        running = true; state = initialPinch; target = focusedPinchTarget(targets(), active());
        return;
      }
      if (payload.phase === "end") {
        running = false; state = initialPinch; target = null;
        return;
      }
      if (!running) {
        // Update without a begin (listener attached mid-gesture): start here, without a jump.
        running = true; state = { level: pinchLevel(payload.scale) }; target = focusedPinchTarget(targets(), active());
        return;
      }
      const result = pinchSteps(state, payload);
      state = result.state;
      // A tab closed mid-gesture has unregistered its target; never zoom a disposed view.
      if (result.steps !== 0 && target && isRegistered(targets(), target)) target.zoomBy(result.steps);
    },
  };
}

function isRegistered(targets: Iterable<PinchTarget>, target: PinchTarget): boolean {
  for (const candidate of targets) if (candidate === target) return true;
  return false;
}

const targets = new Set<PinchTarget>();

/** Registers a terminal or editor as pinch target; returns the function that removes it again. */
export function registerPinchTarget(target: PinchTarget): () => void {
  targets.add(target);
  return () => { targets.delete(target); };
}

let installed: Promise<() => void> | null = null;

/** Starts listening for pinch events once per page; later calls return the same subscription. */
export function installPinchZoom(): Promise<() => void> {
  if (installed) return installed;
  const router = createPinchRouter(() => targets, () => document.activeElement);
  installed = listen<PinchPayload>(pinchEvent, event => router.handle(event.payload));
  installed.catch(() => { installed = null; });
  return installed;
}
