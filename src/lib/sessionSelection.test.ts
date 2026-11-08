import { describe, expect, it } from "vitest";
import { buildSessionTree, collectFolderSessions, searchSessions, selectSessions, type SavedSession } from "./sessions";

const empty = { ids: [] as string[], anchor: "" };
const visible = ["a", "b", "c"];
describe("session selection", () => {
  it("selects singly and toggles with Ctrl/Cmd without duplicates", () => {
    const single = selectSessions(empty, visible, "b", "single");
    expect(single).toEqual({ ids: ["b"], anchor: "b" });
    const multi = selectSessions(single, visible, "a", "toggle");
    expect(multi.ids).toEqual(["b", "a"]);
    expect(selectSessions(multi, visible, "b", "toggle").ids).toEqual(["a"]);
    expect(selectSessions(multi, visible, "c", "single").ids).toEqual(["c"]);
  });
  it("extends and shrinks ranges in visible session order, excluding folders", () => {
    const anchor = selectSessions(empty, visible, "c", "single");
    const range = selectSessions(anchor, visible, "a", "range");
    expect(range).toEqual({ ids: ["a", "b", "c"], anchor: "c" });
    expect(selectSessions(range, visible, "b", "range").ids).toEqual(["b", "c"]);
    expect(selectSessions(range, visible, "", "range")).toEqual(range);
    expect(selectSessions({ ids: ["hidden"], anchor: "hidden" }, visible, "b", "range").ids).toEqual(["b"]);
  });
  it("selects only filtered visible sessions with Ctrl+A", () => {
    const sessions = [
      { id: "a", name: "Alpha", folder: "Lab", host: "one", user: null },
      { id: "b", name: "Beta", folder: "Lab/Sub", host: "two", user: null },
      { id: "c", name: "Gamma", folder: "Other", host: "three", user: null },
    ] as SavedSession[];
    const filtered = searchSessions(sessions, "Beta").map(s => s.id);
    expect(selectSessions({ ids: ["a", "c"], anchor: "a" }, filtered, "", "all")).toEqual({ ids: ["b"], anchor: "b" });
    expect(selectSessions(empty, [], "", "all")).toEqual(empty);
    const lab = buildSessionTree(sessions).folders.find(f => f.name === "Lab")!;
    expect(collectFolderSessions(lab).map(s => s.id)).toEqual(["a", "b"]);
  });
});
