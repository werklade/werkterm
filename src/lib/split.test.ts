import { expect, it } from "vitest";
import { assignPane, clampSplitRatio, cleanPanes, seedPanes } from "./split";
it("keeps minimum pane dimensions when resizing or dragging", () => {
  expect(clampSplitRatio(5, 800, 160)).toBe(20);
  expect(clampSplitRatio(95, 800, 160)).toBe(80);
  expect(clampSplitRatio(20, 400, 160)).toBe(40);
  expect(clampSplitRatio(20, 0, 160)).toBe(50);
});
it("seeds active terminal first and leaves unfilled panes empty", () => {
  expect(seedPanes([1, 2, 3], 2, 4)).toEqual([2, 1, 3, null]);
  expect(seedPanes([1], 99, 2)).toEqual([1, null]);
});
it("moves a terminal instead of duplicating it", () => {
  expect(assignPane([1, 2, null], 2, 1)).toEqual([null, 2, 1]);
  expect(assignPane([1, 2], 0, null)).toEqual([null, 2]);
});
it("removes closed and duplicate terminals without filling cleared panes", () => {
  expect(cleanPanes([1, 2, 2, null], [2, 3])).toEqual([null, 2, null, null]);
});
