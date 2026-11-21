/**
 * Pointer-based dragging in the sessions panel. HTML5 drag and drop is not used: the window's native file drop
 * (Tauri onDragDropEvent, used by the file browser) intercepts it differently on Windows, X11 and Wayland.
 */

/** Distance in CSS pixels before a pressed row turns into a drag; below it, the press stays a click. */
export const dragThreshold = 5;

export function passedThreshold(start: { x: number; y: number }, x: number, y: number): boolean {
  return Math.hypot(x - start.x, y - start.y) >= dragThreshold;
}

/** Minimal element shape for hit-testing, so it can be tested without a DOM. */
export interface DropElement { closest(selector: string): { getAttribute(name: string): string | null } | null }

/**
 * Folder under the pointer: a row carries its folder in `data-drop-folder` (folder row: its path, session row: the
 * folder it is in); free space in the list is the top level (""). Outside the list: null.
 */
export function dropTargetAt(element: DropElement | null): string | null {
  if (!element) return null;
  const row = element.closest("[data-drop-folder]");
  if (row) return row.getAttribute("data-drop-folder");
  return element.closest(".sessions-list") ? "" : null;
}
