import type { SyntheticEvent } from "react";
import { renameSelection } from "../lib/inlineRename";

/**
 * Name field shown in place of a file browser entry. Enter and blur apply, Escape cancels; `onDone`
 * runs once with the new value or null. Key and mouse events stay inside the field so the row's
 * keyboard handling (Enter opens, Delete deletes, arrows move) does not react while editing.
 */
export function InlineRename({ name, file, label, onDone }: { name: string; file: boolean; label: string; onDone: (value: string | null) => void }) {
  const finish = (input: HTMLInputElement, value: string | null) => {
    if (input.dataset.done) return;
    input.dataset.done = "1";
    onDone(value);
  };
  return <input className="browser-rename" aria-label={label} defaultValue={name} data-file={file ? "1" : undefined} ref={focusName} spellCheck={false} autoComplete="off"
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); finish(event.currentTarget, event.currentTarget.value); }
      else if (event.key === "Escape") { event.preventDefault(); finish(event.currentTarget, null); }
    }}
    onBlur={event => finish(event.currentTarget, event.currentTarget.value)}
    onClick={stop} onDoubleClick={stop} onContextMenu={stop} />;
}
const stop = (event: SyntheticEvent) => event.stopPropagation();
// Module-level callback ref: React calls it once on mount, so typing never resets the selection.
function focusName(input: HTMLInputElement | null) {
  if (!input) return;
  input.focus();
  const [start, end] = renameSelection(input.value, input.dataset.file === "1");
  input.setSelectionRange(start, end);
}
