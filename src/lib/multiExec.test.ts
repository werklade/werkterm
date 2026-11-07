import { expect, it } from "vitest";
import { gridColumns, inputTargets, pasteLines, requiresPasteConfirmation } from "./multiExec";
it("selects live checked targets and always the focused terminal", () => {
  const terminals = [{id:1,checked:true,exited:false},{id:2,checked:true,exited:false},{id:3,checked:true,exited:true}];
  expect(inputTargets(1,terminals)).toEqual([1,2]);
  expect(inputTargets(1,[{...terminals[0],checked:false},terminals[1]])).toEqual([1]);
  expect(inputTargets(3,terminals)).toEqual([]);
});
it("calculates square grid columns and multiline paste", () => {
  expect([0,1,2,4,5,9].map(gridColumns)).toEqual([1,1,2,2,3,3]);
  expect(pasteLines("hello")).toBe(0);
  expect(pasteLines("a\r\nb")).toBe(2);
  expect(pasteLines("\x1b[200~a\nb\x1b[201~")).toBe(2);
});

it("confirms multiline pastes but never ordinary Enter", () => {
  expect(requiresPasteConfirmation(true, false, "\r")).toBe(false);
  expect(requiresPasteConfirmation(true, true, "\r")).toBe(true);
  expect(requiresPasteConfirmation(false, true, "a\nb")).toBe(false);
  expect(requiresPasteConfirmation(true, true, "hello")).toBe(false);
  expect(requiresPasteConfirmation(true, true, "a\nb")).toBe(true);
});
