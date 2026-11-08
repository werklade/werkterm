import { describe, expect, it } from "vitest";
import { mergeFolders, selectRows, swapPair, type FolderEntry, type FolderResult, type FolderPair } from "./folderDiff";
const entry = (path: string, size = 8, mtime: number | null = 100, kind = "file"): FolderEntry => ({ path, size, mtime, kind });
const result = (left: FolderEntry[], right: FolderEntry[], content: Record<string, boolean> = {}): FolderResult => ({ left: { entries: left, truncated: false }, right: { entries: right, truncated: false }, content, limited: false });
describe("folder comparisons", () => {
  it("merges by relative path and classifies all categories", () => {
    const rows = mergeFolders(result([entry("same"), entry("changed"), entry("left"), entry("type")], [entry("same"), entry("changed", 9), entry("right"), entry("type", 0, 100, "dir")]));
    expect(Object.fromEntries(rows.map(r => [r.path, r.result]))).toEqual({ same: "gleich", changed: "unterschiedlich", left: "nur links", right: "nur rechts", type: "Typ unterschiedlich" });
  });
  it("allows two seconds, requires known times and distinguishes size", () => {
    expect(mergeFolders(result([entry("a"), entry("b"), entry("c", 8, null)], [entry("a", 8, 102), entry("b", 8, 103), entry("c", 8, null)])).map(r => r.result)).toEqual(["gleich", "unterschiedlich", "unterschiedlich"]);
  });
  it("content decides despite timestamps", () => {
    const rows = mergeFolders(result([entry("a"), entry("b")], [entry("a", 8, 900), entry("b")], { a: true, b: false }));
    expect(rows.map(r => r.result)).toEqual(["gleich", "unterschiedlich"]);
    expect(rows[0].timeHint).toBe(true);
  });
  it("sorts dates and sizes numerically and filters by name and differences", () => {
    const rows = mergeFolders(result([entry("dir/z", 100), entry("a", 9), entry("same")], [entry("same")]));
    expect(selectRows(rows, "leftSize", false, true, "").map(r => r.name)).toEqual(["a", "z"]);
    expect(selectRows(rows, "name", true, false, "Z").map(r => [r.name, r.folder])).toEqual([["z", "dir"]]);
    expect(selectRows(rows, "leftDate", false, true, "")).toHaveLength(2);
  });
  it("swaps sources and preserves options, reversing one-sided entries", () => {
    const pair: FolderPair = { sources: [{ path: "a", tab: { id: 0, kind: "local", title: "", browserPath: "", exited: false } }, { path: "b", tab: { id: 1, kind: "ssh", title: "", browserPath: "", exited: false } }], options: { recursive: true, contents: true } };
    expect(swapPair(swapPair(pair))).toEqual(pair);
    expect(swapPair(pair).sources[0].path).toBe("b");
    const data = result([entry("x")], []);
    expect(mergeFolders({ ...data, left: data.right, right: data.left })[0].result).toBe("nur rechts");
  });
  it("handles 50 000 paths without duplicate rows", () => {
    const entries = Array.from({ length: 50_000 }, (_, i) => entry(`dir/${i}`));
    const rows = mergeFolders(result(entries, entries));
    expect(rows).toHaveLength(50_000);
    expect(selectRows(rows, "name", false, true, "")).toHaveLength(0);
  });
});
