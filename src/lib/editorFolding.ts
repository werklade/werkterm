export interface FoldRange { from: number; to: number }
const indentation = (text: string) => (text.match(/^[\t ]*/)?.[0] ?? "").replace(/\t/g, "    ").length;
/** Empty lines belong to a block only when followed by another indented line. */
export function indentationFold(text: string, lineStart: number): FoldRange | null {
  const end = text.indexOf("\n", lineStart);
  if (end < 0 || !text.slice(lineStart, end).trim()) return null;
  const base = indentation(text.slice(lineStart, end));
  let cursor = end + 1;
  let last = end;
  while (cursor <= text.length) {
    const next = text.indexOf("\n", cursor);
    const lineEnd = next < 0 ? text.length : next;
    const line = text.slice(cursor, lineEnd);
    if (line.trim()) {
      if (indentation(line) <= base) break;
      last = lineEnd;
    }
    if (next < 0) break;
    cursor = next + 1;
  }
  return last > end ? { from: end, to: last } : null;
}
/** Fallback brace scanner skips quoted strings and line/block comments. */
export function braceFold(text: string, lineStart: number): FoldRange | null {
  const lineEnd = text.indexOf("\n", lineStart);
  const end = lineEnd < 0 ? text.length : lineEnd;
  let depth = 0, opening = -1, quote = "", comment = false, lineComment = false;
  for (let i = lineStart; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (lineComment) { if (c === "\n") lineComment = false; continue; }
    if (comment) { if (c === "*" && next === "/") { comment = false; i++; } continue; }
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && next === "*") { comment = true; i++; continue; }
    if ((c === "/" && next === "/") || c === "#") { lineComment = true; continue; }
    if (c === "{") { if (opening < 0) { if (i > end) return null; opening = i; } depth++; }
    if (c === "}" && opening >= 0 && --depth === 0) return i > end ? { from: opening + 1, to: i } : null;
    if (i >= end && opening < 0) return null;
  }
  return null;
}
