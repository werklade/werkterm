import { getCurrentWebview } from "@tauri-apps/api/webview";

/** Fired on window after the interface size changed; terminals refit and the Tux overlay re-measures. */
export const uiScaleEvent = "werkterm-ui-scale";

export interface UiScaler {
  /** Sets the size in percent. Rejects on failure; a failed size is tried again on the next call. */
  apply(percent: number): Promise<void>;
  /** Last size set successfully (the webview starts at 100). */
  applied(): number;
}

/**
 * Builds the interface size control. A size that is already set, or whose request is still running, is not
 * requested again, so the early call in main.tsx and the one in App do not zoom twice. A failed request is
 * forgotten, so every later call tries again.
 */
export function createUiScaler(setZoom: (factor: number) => Promise<void>, notify: () => void): UiScaler {
  let applied = 100;
  let pending: { percent: number; done: Promise<void> } | null = null;
  return {
    apply(percent) {
      if (pending && pending.percent === percent) return pending.done;
      if (!pending && applied === percent) return Promise.resolve();
      const done: Promise<void> = Promise.resolve()
        .then(() => setZoom(percent / 100))
        .then(() => { applied = percent; notify(); })
        .finally(() => { if (pending?.done === done) pending = null; });
      pending = { percent, done };
      return done;
    },
    applied: () => applied,
  };
}

/**
 * Size the setting should fall back to after `failed` could not be set: the last size set successfully,
 * or null if the setting already moved on to another size (that request reports for itself) or nothing changes.
 */
export function revertedUiScale(failed: number, setting: number, applied: number): number | null {
  return setting === failed && setting !== applied ? applied : null;
}

/** Resolves once `done` settles or after `ms`, whichever comes first; never rejects. */
export function settleWithin(done: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([done.then(() => {}, () => {}), new Promise<void>(resolve => setTimeout(resolve, ms))]);
}

const notifyResized = () => {
  // One frame later the layout has the new size; ResizeObservers usually fire anyway, this is the explicit fallback.
  const fire = () => window.dispatchEvent(new Event(uiScaleEvent));
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fire); else fire();
};

/** Webview zoom = percent / 100. */
export const uiScaler = createUiScaler(factor => getCurrentWebview().setZoom(factor), notifyResized);
