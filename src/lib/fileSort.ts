import type { DirEntry } from "./fs";
import { getLanguage } from "../i18n";

export type FileSortColumn = "name" | "size" | "modified";
export interface FileSort {
  column: FileSortColumn;
  direction: "asc" | "desc";
}

export const defaultFileSort: FileSort = { column: "name", direction: "asc" };
const storageKey = "werkterm.fileBrowser.sort";
const directory = (entry: DirEntry) => entry.kind === "dir" || (entry.kind === "symlink" && entry.targetIsDir);
const compareName = (a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name, getLanguage(), { numeric: true, sensitivity: "base" });

/** Returns a new array; directories remain first for either direction. */
export function sortFileEntries(entries: readonly DirEntry[], sort: FileSort): DirEntry[] {
  return [...entries].sort((a, b) => {
    const folders = Number(directory(b)) - Number(directory(a));
    if (folders) return folders;
    const value = sort.column === "name" ? compareName(a, b)
      : sort.column === "size" ? a.size - b.size
      : (a.modified ?? Number.NEGATIVE_INFINITY) - (b.modified ?? Number.NEGATIVE_INFINITY);
    return (value || compareName(a, b)) * (sort.direction === "asc" ? 1 : -1);
  });
}

export function loadFileSort(): FileSort {
  try {
    const saved: unknown = JSON.parse((localStorage.getItem(storageKey) ?? localStorage.getItem(storageKey.replace(/^werkterm\./, "linmoba."))) ?? "null");
    if (saved && typeof saved === "object" && "column" in saved && "direction" in saved
      && (saved.column === "name" || saved.column === "size" || saved.column === "modified")
      && (saved.direction === "asc" || saved.direction === "desc")) {
      return { column: saved.column, direction: saved.direction };
    }
  } catch { /* Storage may be unavailable or contain an older invalid value. */ }
  return { ...defaultFileSort };
}

export function saveFileSort(sort: FileSort): void {
  try { localStorage.setItem(storageKey, JSON.stringify(sort)); }
  catch { /* Sorting still works when persistent storage is unavailable. */ }
}
