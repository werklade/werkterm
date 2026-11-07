import { describe, expect, it } from "vitest";
import { beginClose, advanceClose } from "./editorClose";
describe("editor close sequence", () => {
  it("visits every document in order after save and discard", () => {
    let state = beginClose([3, 7, 9]);
    state = advanceClose(state, "save");
    expect(state.remaining).toEqual([7, 9]);
    state = advanceClose(state, "discard");
    expect(state.remaining).toEqual([9]);
    expect(advanceClose(state, "save").phase).toBe("done");
  });
  it("stops at cancellation and failed save without advancing", () => {
    for (const answer of ["cancel", "save"] as const) {
      const state = advanceClose(beginClose([1, 2]), answer, false);
      expect(state).toEqual({ remaining: [1, 2], phase: "cancelled" });
      expect(advanceClose(state, "discard")).toBe(state);
    }
  });
  it("handles no changed documents", () => { expect(beginClose([]).phase).toBe("done"); });
});
