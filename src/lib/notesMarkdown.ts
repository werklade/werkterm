// Tiny Markdown subset for release notes. Pure and defensive: the input is untrusted server text,
// the result is an AST that the UI turns into React elements (never into HTML).

export const notesParseMaxChars = 20000;

export type Inline = { type: "text" | "code" | "bold"; text: string };
export interface ListItem { inlines: Inline[]; children: ListItem[] }
export type Block =
  | { type: "heading"; level: number; inlines: Inline[] }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "list"; items: ListItem[] };

/** Inline parsing: `code` and **bold**; unclosed or empty markers stay literal text. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = () => { if (plain) { out.push({ type: "text", text: plain }); plain = ""; } };
  let i = 0;
  while (i < source.length) {
    if (source[i] === "`") {
      const end = source.indexOf("`", i + 1);
      if (end > i + 1) { flush(); out.push({ type: "code", text: source.slice(i + 1, end) }); i = end + 1; continue; }
    } else if (source.startsWith("**", i)) {
      const end = source.indexOf("**", i + 2);
      if (end > i + 2) { flush(); out.push({ type: "bold", text: source.slice(i + 2, end) }); i = end + 2; continue; }
    }
    plain += source[i];
    i += 1;
  }
  flush();
  return out;
}

const headingRe = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const itemRe = /^([ \t]*)[-*][ \t]+(.*)$/;
const indentOf = (ws: string) => ws.replace(/\t/g, "  ").length;

interface RawItem { raw: string; children: RawItem[] }

const toItem = (raw: RawItem): ListItem => ({ inlines: parseInline(raw.raw), children: raw.children.map(toItem) });

/** Parses notes into blocks. Lists nest one level (indent of two or more spaces); an indented
 *  non-item line continues the previous item; any other line is paragraph text. */
export function parseNotes(source: string): Block[] {
  const lines = source.slice(0, notesParseMaxChars).split(/\r\n|\r|\n/);
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let items: RawItem[] | null = null; // open list
  let last: RawItem | null = null;

  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", inlines: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const endList = () => {
    if (items) blocks.push({ type: "list", items: items.map(toItem) });
    items = null;
    last = null;
  };

  for (const line of lines) {
    if (!line.trim()) { endParagraph(); endList(); continue; }
    const heading = headingRe.exec(line);
    if (heading) {
      endParagraph(); endList();
      blocks.push({ type: "heading", level: heading[1].length, inlines: parseInline(heading[2].trimEnd()) });
      continue;
    }
    const item = itemRe.exec(line);
    if (item) {
      endParagraph();
      const node: RawItem = { raw: item[2].trim(), children: [] };
      const open: RawItem[] = items ?? [];
      items = open;
      const parent = open[open.length - 1];
      if (indentOf(item[1]) >= 2 && parent) parent.children.push(node); else open.push(node);
      last = node;
      continue;
    }
    if (last && /^[ \t]/.test(line)) { (last as RawItem).raw += ` ${line.trim()}`; continue; }
    endList();
    paragraph.push(line.trim());
  }
  endParagraph();
  endList();
  return blocks;
}
