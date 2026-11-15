import { describe, expect, it } from "vitest";
import { notesParseMaxChars, parseInline, parseNotes } from "./notesMarkdown";

const t = (text: string) => ({ type: "text", text });

describe("parseNotes", () => {
  it("returns no blocks for empty or blank input", () => {
    expect(parseNotes("")).toEqual([]);
    expect(parseNotes("  \n\n \t\n")).toEqual([]);
  });
  it("parses headings with their level", () => {
    expect(parseNotes("### Added\n#### Sub\n####### seven")).toEqual([
      { type: "heading", level: 3, inlines: [t("Added")] },
      { type: "heading", level: 4, inlines: [t("Sub")] },
      { type: "paragraph", inlines: [t("####### seven")] },
    ]);
  });
  it("parses bullet lists with - and *, separated from headings by blank lines", () => {
    expect(parseNotes("### Added\n\n- one\n* two\n\n### Changed\n\n- three")).toEqual([
      { type: "heading", level: 3, inlines: [t("Added")] },
      { type: "list", items: [{ inlines: [t("one")], children: [] }, { inlines: [t("two")], children: [] }] },
      { type: "heading", level: 3, inlines: [t("Changed")] },
      { type: "list", items: [{ inlines: [t("three")], children: [] }] },
    ]);
  });
  it("appends indented continuation lines to the previous item", () => {
    expect(parseNotes("- first line\n  continued here\n- second")).toEqual([
      { type: "list", items: [{ inlines: [t("first line continued here")], children: [] }, { inlines: [t("second")], children: [] }] },
    ]);
  });
  it("nests one level by two-space indentation", () => {
    const [list] = parseNotes("- parent\n  - child\n    more child\n- next");
    expect(list).toEqual({ type: "list", items: [
      { inlines: [t("parent")], children: [{ inlines: [t("child more child")], children: [] }] },
      { inlines: [t("next")], children: [] },
    ] });
  });
  it("joins consecutive text lines into one paragraph and splits at blank lines", () => {
    expect(parseNotes("a\nb\n\nc")).toEqual([
      { type: "paragraph", inlines: [t("a b")] },
      { type: "paragraph", inlines: [t("c")] },
    ]);
  });
  it("ends a list at an unindented text line", () => {
    expect(parseNotes("- item\ntext")).toEqual([
      { type: "list", items: [{ inlines: [t("item")], children: [] }] },
      { type: "paragraph", inlines: [t("text")] },
    ]);
  });
  it("keeps HTML tags and URLs as literal text", () => {
    const html = "<img src=x onerror=alert(1)><script>x</script>";
    expect(parseNotes(html)).toEqual([{ type: "paragraph", inlines: [t(html)] }]);
    expect(parseNotes("- see https://example.org/a")).toEqual([{ type: "list", items: [{ inlines: [t("see https://example.org/a")], children: [] }] }]);
  });
  it("handles CRLF line endings", () => {
    expect(parseNotes("### A\r\n\r\n- b")).toHaveLength(2);
  });
  it("ignores input beyond the defensive cap", () => {
    const blocks = parseNotes("x".repeat(notesParseMaxChars + 500));
    expect(blocks).toHaveLength(1);
    const inline = (blocks[0] as { inlines: { text: string }[] }).inlines[0];
    expect(inline.text).toHaveLength(notesParseMaxChars);
  });
});

describe("parseInline", () => {
  it("parses code and bold", () => {
    expect(parseInline("a `Comment[de]` and **bold** end")).toEqual([
      t("a "), { type: "code", text: "Comment[de]" }, t(" and "), { type: "bold", text: "bold" }, t(" end"),
    ]);
  });
  it("keeps unclosed or empty markers literal", () => {
    expect(parseInline("a `open")).toEqual([t("a `open")]);
    expect(parseInline("**open")).toEqual([t("**open")]);
    expect(parseInline("a `` b")).toEqual([t("a `` b")]);
    expect(parseInline("**** x")).toEqual([t("**** x")]);
  });
  it("does not interpret Markdown inside code", () => {
    expect(parseInline("`**x**`")).toEqual([{ type: "code", text: "**x**" }]);
  });
  it("returns nothing for empty input", () => {
    expect(parseInline("")).toEqual([]);
  });
});
