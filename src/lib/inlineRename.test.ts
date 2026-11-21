import { describe, expect, it } from "vitest";
import { renameOutcome, renameSelection } from "./inlineRename";

describe("renameSelection", () => {
  it("selects a file name without its extension", () => {
    expect(renameSelection("report.final.txt", true)).toEqual([0, 12]);
    expect(renameSelection("Makefile", true)).toEqual([0, 8]);
  });
  it("selects dotfiles and folders completely", () => {
    expect(renameSelection(".bashrc", true)).toEqual([0, 7]);
    expect(renameSelection("site.d", false)).toEqual([0, 6]);
  });
});

describe("renameOutcome", () => {
  it("keeps an unchanged name and renames to a valid one", () => {
    expect(renameOutcome("a.txt", "a.txt")).toEqual({ type: "keep" });
    expect(renameOutcome("a.txt", "b c.txt")).toEqual({ type: "rename", name: "b c.txt" });
    expect(renameOutcome("a.txt", "A.txt")).toEqual({ type: "rename", name: "A.txt" });
  });
  it.each(["", ".", "..", "sub/a.txt", "/a", "a\0b"])("rejects %j", value => {
    expect(renameOutcome("a.txt", value)).toEqual({ type: "invalid" });
  });
});
