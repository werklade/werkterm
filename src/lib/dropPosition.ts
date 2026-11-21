/**
 * Converts the position of a native file drop (Tauri onDragDropEvent) to CSS pixels.
 * Windows reports physical pixels. On Linux wry/GTK reports logical window pixels although the
 * type says physical (measured on Ubuntu 26.04 at scale 2, issue #28); devicePixelRatio also
 * contains the webview zoom (interface size), so logical / zoom = logical * scale / dpr.
 */
export function dropToCss(position: { x: number; y: number }, opts: { linux: boolean; scaleFactor: number; devicePixelRatio: number }): { x: number; y: number } {
  const valid = (value: number) => (Number.isFinite(value) && value > 0 ? value : 1);
  const factor = opts.linux ? valid(opts.scaleFactor) / valid(opts.devicePixelRatio) : 1 / valid(opts.devicePixelRatio);
  return { x: position.x * factor, y: position.y * factor };
}
