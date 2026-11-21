import { validRemoteName } from "./transfers";

/** Initial selection in the name field: files without their extension, folders and dotfiles completely. */
export function renameSelection(name: string, file: boolean): [number, number] {
  const dot = name.lastIndexOf(".");
  return file && dot > 0 ? [0, dot] : [0, name.length];
}

export type RenameOutcome = { type: "keep" } | { type: "invalid" } | { type: "rename"; name: string };
/** What applying `value` to the entry `name` does: nothing (unchanged), an error, or a rename. */
export function renameOutcome(name: string, value: string): RenameOutcome {
  if (value === name) return { type: "keep" };
  return validRemoteName(value) ? { type: "rename", name: value } : { type: "invalid" };
}
