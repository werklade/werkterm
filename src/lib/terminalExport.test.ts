import { describe, expect, it } from "vitest";
import type { IBuffer, IBufferCell } from "@xterm/xterm";
import { appendRun, cellStyle, escapeHtml, escapeRtf, exportHtml, exportRtf, exportText, paletteColor, readTerminal, type RunStyle, type TerminalDocument, type TextRun } from "./terminalExport";
const style: RunStyle = { fg: "#ffffff", bg: "#000000", bold: false, italic: false, underline: false, dim: false };
function cell(text: string, width = 1, overrides = {}): IBufferCell {
  return { getChars: () => text, getWidth: () => width, getFgColor: () => 0, getBgColor: () => 0, isFgDefault: () => true, isBgDefault: () => true, isFgPalette: () => false, isBgPalette: () => false, isFgRGB: () => false, isBgRGB: () => false, isInverse: () => 0, isBold: () => 0, isItalic: () => 0, isUnderline: () => 0, isDim: () => 0, ...overrides } as unknown as IBufferCell;
}
function buffer(rows: { cells: IBufferCell[]; wrapped?: boolean }[]): IBuffer {
  return { length: rows.length, getLine: (y: number) => {
    const row = rows[y];
    return row && { length: row.cells.length, isWrapped: !!row.wrapped, getCell: (x: number) => row.cells[x], translateToString: () => row.cells.map(c => c.getChars() || (c.getWidth() ? " " : "")).join("").trimEnd() };
  } } as unknown as IBuffer;
}
describe("terminal export", () => {
  it("escapes HTML text, title and font without external resources", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    const doc: TerminalDocument = { lines: [[{ text: "<script>&", style }]], background: "#000000", foreground: "#ffffff", fontFamily: 'Mono"' };
    const html = exportHtml(doc, "<title>");
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("&lt;script&gt;&amp;"); expect(html).toContain("&lt;title&gt;"); expect(html).toContain("&quot;Mono&quot;"); expect(html).not.toContain("<script>");
  });
  it("escapes RTF syntax and encodes UTF-16 including emoji as signed values", () => {
    expect(escapeRtf("\\{}é😀")).toBe("\\\\\\{\\}\\u233?\\u-10179?\\u-8704?");
    const doc: TerminalDocument = { lines: [[{ text: "é😀", style: { ...style, bold: true, italic: true, underline: true } }], [{ text: "end", style }]], background: "#000000", foreground: "#ffffff", fontFamily: '"Mono", monospace' };
    const rtf = exportRtf(doc);
    expect(rtf).toContain("{\\rtf1\\ansi\\deff0"); expect(rtf).toContain("\\b1\\i1\\ul1"); expect(rtf).toContain("\\line"); expect(rtf).toContain("\\highlight2"); expect(rtf).toContain("\\u-10179?\\u-8704?");
    expect(exportText(doc)).toBe("é😀\nend"); expect(exportText(doc, true)).toBe("é😀\r\nend");
  });
  it("keeps CSS metacharacters inside quoted font names", () => {
    const doc: TerminalDocument = { lines: [], background: "#000000", foreground: "#ffffff", fontFamily: 'Mono; background:url(https://example.invalid/x)' };
    expect(exportHtml(doc, "export")).toContain('font-family:&quot;Mono; background:url(https://example.invalid/x)&quot;,monospace');
    expect(escapeRtf("a\t{b}\\")).toBe("a\\tab \\{b\\}\\\\");
  });
  it("merges only identical adjacent styles", () => {
    const line: TextRun[] = [];
    appendRun(line, "a", style); appendRun(line, "b", { ...style }); appendRun(line, "c", { ...style, bold: true });
    expect(line.map(r => r.text)).toEqual(["ab", "c"]);
  });
  it("resolves palette, RGB, inverse and attributes", () => {
    expect(cellStyle(cell("x", 1, { isInverse: () => 1, isBold: () => 1, isDim: () => 1 }), { foreground: "#112233", background: "#445566" })).toMatchObject({ fg: "#445566", bg: "#112233", bold: true, dim: true });
    expect(cellStyle(cell("x", 1, { isFgDefault: () => false, isFgPalette: () => true, getFgColor: () => 1, isBgDefault: () => false, isBgRGB: () => true, getBgColor: () => 0x123456 }), { red: "#abcdef" })).toMatchObject({ fg: "#abcdef", bg: "#123456" });
    expect(paletteColor(16)).toBe("#000000"); expect(paletteColor(21)).toBe("#0000ff"); expect(paletteColor(196)).toBe("#ff0000"); expect(paletteColor(231)).toBe("#ffffff"); expect(paletteColor(232)).toBe("#080808"); expect(paletteColor(255)).toBe("#eeeeee");
  });
  it("joins wrapped rows, skips wide continuation cells and removes final blank rows", () => {
    const doc = readTerminal(buffer([{ cells: [cell("a"), cell(" ")] }, { cells: [cell("😀", 2), cell("", 0), cell("界", 2), cell("", 0), cell("")], wrapped: true }, { cells: [cell("x"), cell("")] }, { cells: [cell("")] } ]));
    expect(exportText(doc)).toBe("a 😀界\nx");
    expect(doc.lines[0]).toHaveLength(1);
  });
});
