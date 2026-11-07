import { describe, expect, it } from "vitest";
import { braceFold, indentationFold } from "./editorFolding";

describe("indentation folding", () => {
  it("folds a larger indentation block until the next peer", () => {
    const text = "root:\n  first\n    nested\n  second\npeer";
    expect(indentationFold(text, 0)).toEqual({ from: 5, to: text.indexOf("\npeer") });
    expect(indentationFold(text, 6)).toEqual({ from: 13, to: text.indexOf("\n  second") });
  });
  it("includes internal blank lines but excludes trailing blank lines", () => {
    const text = "root\n  one\n\n  two\n\npeer";
    expect(indentationFold(text, 0)).toEqual({ from: 4, to: text.indexOf("\n\npeer") });
  });
  it("supports tabs and a final line without newline", () => expect(indentationFold("root\n\tchild", 0)).toEqual({ from: 4, to: 11 }));
  it("does not fold flat text, empty lines or the last line", () => {
    expect(indentationFold("one\ntwo", 0)).toBeNull();
    expect(indentationFold("\n  child", 0)).toBeNull();
    expect(indentationFold("last", 0)).toBeNull();
  });
});

describe("brace folding fallback", () => {
  it("matches nested braces and skips comments and strings", () => {
    const text = 'server {\n  value = "}"; // }\n  /* } */\n  child {\n    x\n  }\n}';
    expect(braceFold(text, 0)).toEqual({ from: 8, to: text.length - 1 });
  });
  it("ignores inline pairs, hash comments and incomplete blocks", () => {
    expect(braceFold("x {}\nnext", 0)).toBeNull();
    expect(braceFold("# fake {\n  x\n}", 0)).toBeNull();
    expect(braceFold("x {\n  child", 0)).toBeNull();
  });
});
