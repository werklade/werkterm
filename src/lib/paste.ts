export type PasteConfirm = "multiline" | "always" | "never";
export function hasPasteControls(text: string): boolean { return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text); }
export function shouldConfirmPaste(text: string, mode: PasteConfirm): boolean {
  return hasPasteControls(text) || (mode !== "never" && (mode === "always" || text.length > 1024 || /[\r\n]/.test(text)));
}
export function stripLastNewline(text: string): string { return text.replace(/(?:\r\n|\n|\r)$/, ""); }
export function singleLinePaste(text: string): string { return text.replace(/\r\n|\r|\n/g, " "); }
