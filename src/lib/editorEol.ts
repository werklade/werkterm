import type { EditorDocument, EditorEol, EolCounts } from "./editorTypes";

export function initialEol(eol: EditorDocument["eol"]): EditorEol | null {
  return eol === "mixed" ? null : eol === "none" ? "lf" : eol;
}
/** Ties deliberately prefer LF, then CRLF, then CR. */
export function mostFrequentEol(counts: EolCounts): EditorEol {
  return (["lf", "crLf", "cr"] as const).reduce((best, kind) => counts[kind] > counts[best] ? kind : best, "lf" as EditorEol);
}
export function eolChanged(original: EditorDocument["eol"], target: EditorEol | null): boolean {
  return target !== initialEol(original);
}
