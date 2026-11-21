/** How long the status line offers "Undo" after a move or rename. */
export const undoTimeoutMs = 10_000;

export interface UndoEntry { message: string; run: () => void }
interface Timers { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
const browserTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One undo offer at a time; a new offer replaces the old one, which then expires. */
export function createUndoSlot(onChange: (entry: UndoEntry | null) => void, timers: Timers = browserTimers) {
  let current: UndoEntry | null = null;
  let timer: unknown;
  const stop = () => { if (timer !== undefined) timers.clear(timer); timer = undefined; };
  const set = (entry: UndoEntry | null) => {
    stop();
    current = entry;
    onChange(entry);
    if (entry) timer = timers.set(() => { timer = undefined; set(null); }, undoTimeoutMs);
  };
  return {
    offer: (message: string, run: () => void) => set({ message, run }),
    /** Runs the offered undo once; later calls do nothing. */
    take: () => { const entry = current; if (entry) { set(null); entry.run(); } },
    dispose: () => { stop(); current = null; },
  };
}
