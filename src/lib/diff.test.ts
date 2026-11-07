import { describe, it, expect, vi } from "vitest";
import { diffTitle, normalizedWhitespace, differenceCount, rememberedSource, comparisonSources, whitespaceDiff, loadDiffDocument, diffError, whitespaceAvailable } from "./diff";
import type { DiffSource } from "./diff";
const source: DiffSource = { tab: { id: 7, kind: "ssh", sessionId: 9, title: "Server", browserPath: "", exited: false }, path: "/etc/a" };
describe("file comparison", () => {
  it("remembers and compares sources across servers", () => {
    expect(rememberedSource(source, [source.tab])).toBe(source);
    const other = { ...source, tab: { ...source.tab, id: 8, sessionId: 10 } };
    expect(comparisonSources(source, other)).toEqual([source, other]);
    expect(comparisonSources(null, other)).toBeNull();
  });
  it("expires on closure, exit or a different session", () => {
    expect(rememberedSource(source, [])).toBeNull();
    expect(rememberedSource(source, [{ ...source.tab, exited: true }])).toBeNull();
    expect(rememberedSource(source, [{ ...source.tab, sessionId: 11 }])).toBeNull();
    expect(rememberedSource({ ...source, tab: { ...source.tab, id: 0, kind: "local" } }, [])).not.toBeNull();
  });
  it("builds titles for Windows and POSIX paths", () => expect(diffTitle("C:\\dir\\a.ts", "/etc/b")).toBe("Vergleich: a.ts ↔ b"));
  it("normalizes horizontal whitespace while retaining lines and offsets", () => {
    expect(normalizedWhitespace(" a\t b\n")).toEqual({ value: "ab\n", positions: new Uint32Array([1, 4, 5, 6]) });
    expect(whitespaceDiff(" a b ", "ab")).toEqual([]);
    const changes = whitespaceDiff(" a x", "a y");
    expect(changes[0].fromA).toBe(3); expect(changes[0].fromB).toBe(2);
  });
  it("allows whitespace filtering only up to one MiB on both sides", () => {
    expect(whitespaceAvailable([1024 * 1024, 12])).toBe(true);
    expect(whitespaceAvailable([1024 * 1024 + 1, 12])).toBe(false);
    expect(whitespaceAvailable([12, 1024 * 1024 + 1])).toBe(false);
    expect(normalizedWhitespace("😀 \tx\n").positions).toEqual(new Uint32Array([0, 1, 4, 5, 6]));
  });
  it("counts changed chunks consistently and ignores EOL differences", () => {
    expect(differenceCount("a\r\nb\r", "a\nb\n")).toBe(0);
    expect(differenceCount("a\nb", "a\nc")).toBe(1);
    expect(differenceCount("a b", "ab", true)).toBe(0);
    expect(differenceCount("a b", "ab")).toBe(1);
    expect(differenceCount("", "x")).toBe(1);
    expect(differenceCount("a\nb", "ab", true)).toBe(1);
  });
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
describe("comparison loading", () => {
  it("preserves a load error when closing also fails", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ docId: 44, size: 5 * 1024 * 1024 + 1, text: "" }).mockRejectedValueOnce("close failed");
    await expect(loadDiffDocument(source)).rejects.toBe("TOO_LARGE:");
    vi.mocked(invoke).mockResolvedValueOnce({ docId: 45, size: 1, text: "x" }).mockRejectedValueOnce("close failed");
    await expect(loadDiffDocument(source)).rejects.toBe("close failed");
  });
  it("releases the editor handle immediately, including oversized files", async () => {
    const call = vi.mocked(invoke);
    call.mockResolvedValueOnce({ docId: 42, size: 12, text: "a\r\nb" }).mockResolvedValueOnce(undefined);
    expect((await loadDiffDocument(source)).text).toBe("a\nb");
    expect(call).toHaveBeenLastCalledWith("editor_close", { docId: 42 });
    call.mockResolvedValueOnce({ docId: 43, size: 5 * 1024 * 1024 + 1, text: "" }).mockResolvedValueOnce(undefined);
    await expect(loadDiffDocument(source)).rejects.toBe("TOO_LARGE:");
    expect(call).toHaveBeenLastCalledWith("editor_close", { docId: 43 });
  });
  it("explains closed sessions without invoking a loader", async () => {
    vi.mocked(invoke).mockClear();
    await expect(loadDiffDocument({ ...source, tab: { ...source.tab, exited: true } })).rejects.toThrow("SESSION_CLOSED");
    expect(invoke).not.toHaveBeenCalled();
    expect(diffError(new Error("SESSION_CLOSED:"))).toContain("Sitzung wurde beendet");
  });
});
