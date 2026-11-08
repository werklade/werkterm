import type { DiffSource } from "./diff";
export interface FolderOptions { recursive: boolean; contents: boolean }
export interface FolderPair { sources: [DiffSource, DiffSource]; options: FolderOptions }
export interface FolderEntry { path: string; kind: string; size: number; mtime: number | null }
export interface FolderResult { left: { entries: FolderEntry[]; truncated: boolean }; right: { entries: FolderEntry[]; truncated: boolean }; content: Record<string, boolean>; limited: boolean }
export const categories = ["gleich", "unterschiedlich", "nur links", "nur rechts", "Typ unterschiedlich"] as const;
export type Category = typeof categories[number];
export interface FolderRow { path: string; name: string; folder: string; result: Category; left?: FolderEntry; right?: FolderEntry; timeHint: boolean }
export type SortColumn = "name" | "folder" | "result" | "leftDate" | "leftSize" | "rightDate" | "rightSize";
export const backendSource = ({ tab, path }: DiffSource) => ({ path, sessionId: tab.kind === "ssh" ? tab.sessionId : null, wslDistro: tab.kind === "wsl" ? tab.cwd?.host : null });
export function mergeFolders(data: FolderResult): FolderRow[] {
  const rows = new Map<string, { left?: FolderEntry; right?: FolderEntry }>();
  for (const entry of data.left.entries) rows.set(entry.path, { left: entry });
  for (const entry of data.right.entries) rows.set(entry.path, { ...rows.get(entry.path), right: entry });
  return Array.from(rows, ([path, { left, right }]) => {
    const timeHint = !!left && !!right && (left.mtime === null || right.mtime === null || Math.abs(left.mtime - right.mtime) > 2);
    const result: Category = !left ? "nur rechts" : !right ? "nur links" : left.kind !== right.kind ? "Typ unterschiedlich" : left.kind === "dir" ? "gleich" : left.kind === "file" && data.content[path] !== undefined ? data.content[path] ? "gleich" : "unterschiedlich" : left.size === right.size && !timeHint ? "gleich" : "unterschiedlich";
    const at = path.lastIndexOf("/");
    return { path, name: path.slice(at + 1), folder: at < 0 ? "" : path.slice(0, at), left, right, result, timeHint };
  });
}
export function selectRows(rows: FolderRow[], column: SortColumn, descending: boolean, differences: boolean, search: string) {
  const value = (row: FolderRow): string | number => column === "leftDate" ? row.left?.mtime ?? -1 : column === "rightDate" ? row.right?.mtime ?? -1 : column === "leftSize" ? row.left?.size ?? -1 : column === "rightSize" ? row.right?.size ?? -1 : row[column];
  const needle = search.toLocaleLowerCase();
  return rows.filter(row => (!differences || row.result !== "gleich") && row.name.toLocaleLowerCase().includes(needle)).sort((a, b) => {
    const x = value(a), y = value(b);
    const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return (order || a.path.localeCompare(b.path)) * (descending ? -1 : 1);
  });
}
export function swapPair(pair: FolderPair): FolderPair { return { ...pair, sources: [pair.sources[1], pair.sources[0]] }; }
