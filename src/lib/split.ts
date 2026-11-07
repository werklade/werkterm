export type SplitMode = "single" | "columns" | "rows" | "quad";
export function clampSplitRatio(value: number, size: number, minimum: number): number {
  const bound = size > 0 ? Math.min(50, Math.max(15, minimum / size * 100)) : 50;
  return Math.min(100 - bound, Math.max(bound, value));
}
export function paneCount(mode: SplitMode): number { return mode === "quad" ? 4 : mode === "single" ? 1 : 2; }
export function seedPanes(ids: number[], active: number | null, count: number): (number | null)[] {
  const ordered = active !== null && ids.includes(active) ? [active, ...ids.filter(id => id !== active)] : ids;
  return Array.from({ length: count }, (_, i) => ordered[i] ?? null);
}
export function cleanPanes(panes: (number | null)[], ids: number[]): (number | null)[] {
  const seen = new Set<number>();
  return panes.map(id => { if (id === null || !ids.includes(id) || seen.has(id)) return null; seen.add(id); return id; });
}
export function assignPane(panes: (number | null)[], index: number, id: number | null): (number | null)[] {
  return panes.map((current, i) => i === index ? id : current === id ? null : current);
}
