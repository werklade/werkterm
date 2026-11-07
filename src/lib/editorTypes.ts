export type EditorEol = "lf" | "crLf" | "cr";
export interface EolCounts { lf: number; crLf: number; cr: number }
export interface EditorDocument {
  docId: number; name: string; path: string; text: string; bom: boolean;
  eol: EditorEol | "mixed" | "none"; eolCounts: EolCounts;
  size: number; mtime: number | null; readonly: boolean;
}
