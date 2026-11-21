import { describe, expect, it } from "vitest";
import { collapseToFocus, EMPTY_SELECTION, focusOnly, isSelected, moveFocus, prune, selectAll, selectRange, selectSingle, toggle, type Selection } from "./browserSelection";

const order = ["a", "b", "c", "d", "e"];
const sel = (names: string[], anchor: string | null, focus: string | null): Selection => ({ names, anchor, focus });

describe("selectSingle", () => {
  it("selects only the clicked entry and makes it anchor and focus", () => {
    expect(selectSingle(sel(["a", "b"], "a", "b"), order, "d")).toEqual(sel(["d"], "d", "d"));
  });
  it("leaves the selection unchanged for an unknown name", () => {
    const before = sel(["a"], "a", "a");
    expect(selectSingle(before, order, "x")).toBe(before);
  });
});

describe("toggle", () => {
  it("adds an entry and keeps the display order", () => {
    expect(toggle(sel(["d"], "d", "d"), order, "b")).toEqual(sel(["b", "d"], "b", "b"));
  });
  it("removes a selected entry but keeps it as anchor and focus", () => {
    expect(toggle(sel(["b", "d"], "b", "b"), order, "d")).toEqual(sel(["b"], "d", "d"));
  });
  it("can remove the last selected entry", () => {
    expect(toggle(sel(["c"], "c", "c"), order, "c")).toEqual(sel([], "c", "c"));
  });
  it("starts a selection from nothing", () => {
    expect(toggle(EMPTY_SELECTION, order, "e")).toEqual(sel(["e"], "e", "e"));
  });
  it("ignores unknown names", () => {
    const before = sel(["a"], "a", "a");
    expect(toggle(before, order, "x")).toBe(before);
  });
  it("does not mutate the input", () => {
    const before = sel(["a"], "a", "a");
    toggle(before, order, "b");
    expect(before).toEqual(sel(["a"], "a", "a"));
  });
});

describe("selectRange", () => {
  it("selects from the anchor down to the clicked entry", () => {
    expect(selectRange(sel(["b"], "b", "b"), order, "d")).toEqual(sel(["b", "c", "d"], "b", "d"));
  });
  it("selects upwards and keeps the anchor", () => {
    expect(selectRange(sel(["d"], "d", "d"), order, "a")).toEqual(sel(["a", "b", "c", "d"], "d", "a"));
  });
  it("replaces the previous range instead of adding to it", () => {
    const first = selectRange(sel(["c"], "c", "c"), order, "e");
    expect(selectRange(first, order, "b")).toEqual(sel(["b", "c"], "c", "b"));
  });
  it("is a single selection without a usable anchor", () => {
    expect(selectRange(EMPTY_SELECTION, order, "c")).toEqual(sel(["c"], "c", "c"));
    expect(selectRange(sel([], "gone", null), order, "c")).toEqual(sel(["c"], "c", "c"));
  });
  it("selects only the anchor when clicking it", () => {
    expect(selectRange(sel(["a", "b"], "b", "a"), order, "b")).toEqual(sel(["b"], "b", "b"));
  });
  it("ignores unknown names", () => {
    const before = sel(["a"], "a", "a");
    expect(selectRange(before, order, "x")).toBe(before);
  });
});

describe("moveFocus", () => {
  it("moves a single selection with the arrow keys and stops at the ends", () => {
    expect(moveFocus(sel(["b"], "b", "b"), order, 1, false)).toEqual(sel(["c"], "c", "c"));
    expect(moveFocus(sel(["b"], "b", "b"), order, -1, false)).toEqual(sel(["a"], "a", "a"));
    expect(moveFocus(sel(["a"], "a", "a"), order, -1, false)).toEqual(sel(["a"], "a", "a"));
    expect(moveFocus(sel(["e"], "e", "e"), order, 1, false)).toEqual(sel(["e"], "e", "e"));
  });
  it("jumps to the first and last entry with Home and End", () => {
    expect(moveFocus(sel(["c"], "c", "c"), order, "start", false)).toEqual(sel(["a"], "a", "a"));
    expect(moveFocus(sel(["c"], "c", "c"), order, "end", false)).toEqual(sel(["e"], "e", "e"));
  });
  it("extends from the anchor with Shift", () => {
    const one = moveFocus(sel(["b"], "b", "b"), order, 1, true);
    expect(one).toEqual(sel(["b", "c"], "b", "c"));
    const two = moveFocus(one, order, 1, true);
    expect(two).toEqual(sel(["b", "c", "d"], "b", "d"));
    expect(moveFocus(two, order, -1, true)).toEqual(sel(["b", "c"], "b", "c"));
  });
  it("shrinks and flips the range across the anchor", () => {
    expect(moveFocus(sel(["b", "c"], "b", "c"), order, -2, true)).toEqual(sel(["a", "b"], "b", "a"));
  });
  it("extends to the ends with Shift+Home and Shift+End", () => {
    expect(moveFocus(sel(["c"], "c", "c"), order, "start", true)).toEqual(sel(["a", "b", "c"], "c", "a"));
    expect(moveFocus(sel(["c"], "c", "c"), order, "end", true)).toEqual(sel(["c", "d", "e"], "c", "e"));
  });
  it("starts the range at the focus when there is no anchor", () => {
    expect(moveFocus(sel([], null, "c"), order, 1, true)).toEqual(sel(["c", "d"], "c", "d"));
  });
  it("starts at the first entry without a focus", () => {
    expect(moveFocus(EMPTY_SELECTION, order, 1, false)).toEqual(sel(["a"], "a", "a"));
    expect(moveFocus(EMPTY_SELECTION, order, -1, true)).toEqual(sel(["a"], "a", "a"));
    expect(moveFocus(EMPTY_SELECTION, order, "end", false)).toEqual(sel(["e"], "e", "e"));
  });
  it("leaves the selection unchanged in an empty list", () => {
    const before = sel(["a"], "a", "a");
    expect(moveFocus(before, [], 1, false)).toBe(before);
  });
});

describe("selectAll", () => {
  it("selects every entry and keeps anchor and focus", () => {
    expect(selectAll(sel(["c"], "c", "d"), order)).toEqual(sel(order, "c", "d"));
  });
  it("uses the first entry when anchor or focus are missing", () => {
    expect(selectAll(EMPTY_SELECTION, order)).toEqual(sel(order, "a", "a"));
  });
  it("returns a copy of the order", () => {
    const result = selectAll(EMPTY_SELECTION, order);
    expect(result.names).not.toBe(order);
  });
  it("is empty for an empty list", () => {
    expect(selectAll(sel(["a"], "a", "a"), [])).toEqual(EMPTY_SELECTION);
  });
});

describe("collapseToFocus", () => {
  it("keeps only the focused entry", () => {
    expect(collapseToFocus(sel(["a", "b", "c"], "a", "c"), order)).toEqual(sel(["c"], "c", "c"));
  });
  it("selects the focused entry even if it was not selected", () => {
    expect(collapseToFocus(sel(["a"], "a", "d"), order)).toEqual(sel(["d"], "d", "d"));
  });
  it("clears everything without a usable focus", () => {
    expect(collapseToFocus(sel(["a"], "a", null), order)).toEqual(EMPTY_SELECTION);
    expect(collapseToFocus(sel(["a"], "a", "x"), order)).toEqual(EMPTY_SELECTION);
  });
});

describe("focusOnly", () => {
  it("moves the focus and keeps names and anchor", () => {
    expect(focusOnly(sel(["a", "b"], "a", "b"), order, "d")).toEqual(sel(["a", "b"], "a", "d"));
  });
  it("returns the same object for the current focus or an unknown name", () => {
    const before = sel(["a"], "a", "a");
    expect(focusOnly(before, order, "a")).toBe(before);
    expect(focusOnly(before, order, "x")).toBe(before);
  });
});

describe("prune", () => {
  it("drops missing names and keeps anchor and focus that still exist", () => {
    expect(prune(sel(["a", "c", "x"], "a", "c"), order)).toEqual(sel(["a", "c"], "a", "c"));
  });
  it("restores the display order after a new sort", () => {
    expect(prune(sel(["a", "c", "e"], "a", "e"), ["e", "d", "c", "b", "a"])).toEqual(sel(["e", "c", "a"], "a", "e"));
  });
  it("moves a missing focus to the first remaining name and a missing anchor to the focus", () => {
    expect(prune(sel(["b", "d"], "x", "y"), order)).toEqual(sel(["b", "d"], "b", "b"));
  });
  it("clears focus and anchor when nothing remains", () => {
    expect(prune(sel(["x"], "x", "x"), order)).toEqual(EMPTY_SELECTION);
  });
  it("keeps a focus on an unselected entry", () => {
    expect(prune(sel([], "c", "c"), order)).toEqual(sel([], "c", "c"));
  });
  it("returns the same object when nothing changed", () => {
    const before = sel(["a", "b"], "a", "b");
    expect(prune(before, order)).toBe(before);
  });
});

it("isSelected reports membership", () => {
  expect(isSelected(sel(["a", "c"], "a", "c"), "c")).toBe(true);
  expect(isSelected(sel(["a", "c"], "a", "c"), "b")).toBe(false);
});
