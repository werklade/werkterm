export const DEFAULT_PANEL_WIDTH = 260;
export interface ColumnWidths { name: number; size: number; modified: number }
export const DEFAULT_COLUMNS: ColumnWidths = { name: 100, size: 65, modified: 110 };
export function loadWidth(key: string, fallback: number): number {
  try { const value = Number(localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^werkterm\./, "linmoba."))); return Number.isFinite(value) && value > 0 ? value : fallback; }
  catch { return fallback; }
}
export function storeWidth(key: string, value: number) {
  try { localStorage.setItem(key, String(value)); } catch { /* Storage can be disabled. */ }
}
export function clampPanel(width: number, windowWidth: number) {
  return Math.max(260, Math.min(windowWidth * .6, width));
}
