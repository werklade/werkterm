type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Stops the webview from scaling the whole UI on ctrl+wheel and pinch gestures.
 * Plain scrolling (no ctrl) is left alone. Returns a function that removes the listeners.
 */
export function installZoomGuard(target: Target = document): () => void {
  const wheel = (event: Event) => { if ((event as WheelEvent).ctrlKey) event.preventDefault(); };
  const gesture = (event: Event) => event.preventDefault();
  const gestureTypes = ["gesturestart", "gesturechange", "gestureend"];
  target.addEventListener("wheel", wheel, { capture: true, passive: false });
  gestureTypes.forEach(type => target.addEventListener(type, gesture, { capture: true, passive: false }));
  return () => {
    target.removeEventListener("wheel", wheel, { capture: true });
    gestureTypes.forEach(type => target.removeEventListener(type, gesture, { capture: true }));
  };
}
