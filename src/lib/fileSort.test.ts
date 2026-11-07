import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "./fs";
import { defaultFileSort, loadFileSort, saveFileSort, sortFileEntries } from "./fileSort";

const file = (name: string, size = 0, modified: number | null = 0, kind: DirEntry["kind"] = "file", targetIsDir = false): DirEntry => ({ name, size, modified, kind, targetIsDir, permissions: 0 });

describe("sortFileEntries", () => {
  it("sorts names naturally without case distinctions and leaves the source unchanged", () => {
    const entries = [file("file10"), file("File2"), file("FILE1")];
    expect(sortFileEntries(entries, { column: "name", direction: "asc" }).map(entry => entry.name)).toEqual(["FILE1", "File2", "file10"]);
    expect(entries[0].name).toBe("file10");
  });
  it.each(["asc", "desc"] as const)("keeps directories and directory symlinks first when %s", direction => {
    const entries = [file("a"), file("b", 0, 0, "dir"), file("c", 0, 0, "symlink", true)];
    expect(sortFileEntries(entries, { column: "name", direction }).slice(0, 2).every(entry => entry.kind !== "file")).toBe(true);
  });
  it("sorts size and dates numerically and reverses direction", () => {
    const entries = [file("a", 100, 20), file("b", 9, 100), file("c", 20, null)];
    expect(sortFileEntries(entries, { column: "size", direction: "asc" }).map(entry => entry.name)).toEqual(["b", "c", "a"]);
    expect(sortFileEntries(entries, { column: "modified", direction: "desc" }).map(entry => entry.name)).toEqual(["b", "a", "c"]);
  });
});

describe("file sort persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("restores the global column and direction", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    expect(loadFileSort()).toEqual(defaultFileSort);
    saveFileSort({ column: "modified", direction: "desc" });
    expect(loadFileSort()).toEqual({ column: "modified", direction: "desc" });
  });

  it.each(["{", '{"column":"unknown","direction":"desc"}'])("ignores invalid saved settings: %s", value => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(loadFileSort()).toEqual(defaultFileSort);
  });

  it("continues sorting when storage access is denied", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(loadFileSort()).toEqual(defaultFileSort);
    expect(() => saveFileSort({ column: "size", direction: "asc" })).not.toThrow();
  });
});
