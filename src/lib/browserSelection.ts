/**
 * Multi-selection of the file browser list. Pure and immutable: every function takes the
 * current selection and the entry names in display order and returns a new selection.
 * `names` always follows the display order, so actions run top to bottom.
 */
export interface Selection {
  /** Selected entry names in display order. */
  names: string[];
  /** Fixed end of a Shift range (last single or Ctrl click). */
  anchor: string | null;
  /** Entry with the keyboard focus (roving tabindex), selected or not. */
  focus: string | null;
}

export const EMPTY_SELECTION: Selection = { names: [], anchor: null, focus: null };

const inOrder = (order: readonly string[], names: Iterable<string>) => {
  const wanted = new Set(names);
  return order.filter(name => wanted.has(name));
};

export const isSelected = (selection: Selection, name: string) => selection.names.includes(name);

/** Plain click: only `name` is selected and becomes anchor and focus. */
export function selectSingle(selection: Selection, order: readonly string[], name: string): Selection {
  if (!order.includes(name)) return selection;
  return { names: [name], anchor: name, focus: name };
}

/** Ctrl/Cmd click: adds or removes `name`; it becomes anchor and focus either way. */
export function toggle(selection: Selection, order: readonly string[], name: string): Selection {
  if (!order.includes(name)) return selection;
  const names = isSelected(selection, name) ? selection.names.filter(item => item !== name) : [...selection.names, name];
  return { names: inOrder(order, names), anchor: name, focus: name };
}

/** Shift click: everything from the anchor to `name` in display order; the anchor stays. */
export function selectRange(selection: Selection, order: readonly string[], name: string): Selection {
  const end = order.indexOf(name);
  if (end < 0) return selection;
  const start = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  if (start < 0) return selectSingle(selection, order, name);
  return { names: order.slice(Math.min(start, end), Math.max(start, end) + 1), anchor: selection.anchor, focus: name };
}

/**
 * Arrow keys, Home and End. Without `extend` the target becomes the only selected entry,
 * with `extend` (Shift) the range from the anchor to the target is selected.
 * Without a focus, the first entry is the target of every move except "end".
 */
export function moveFocus(selection: Selection, order: readonly string[], delta: number | "start" | "end", extend: boolean): Selection {
  if (order.length === 0) return selection;
  const current = selection.focus === null ? -1 : order.indexOf(selection.focus);
  const index = delta === "start" ? 0 : delta === "end" ? order.length - 1
    : current < 0 ? 0 : Math.max(0, Math.min(order.length - 1, current + delta));
  const target = order[index];
  if (!extend) return selectSingle(selection, order, target);
  // A Shift move without anchor starts the range at the entry that had the focus.
  const anchor = selection.anchor !== null && order.includes(selection.anchor) ? selection.anchor : current >= 0 ? order[current] : target;
  return selectRange({ ...selection, anchor }, order, target);
}

/** Ctrl+A: every entry; anchor and focus stay where they were if still present. */
export function selectAll(selection: Selection, order: readonly string[]): Selection {
  if (order.length === 0) return EMPTY_SELECTION;
  const keep = (name: string | null) => name !== null && order.includes(name) ? name : order[0];
  return { names: [...order], anchor: keep(selection.anchor), focus: keep(selection.focus) };
}

/** Escape: only the focused entry stays selected; without focus nothing is selected. */
export function collapseToFocus(selection: Selection, order: readonly string[]): Selection {
  if (selection.focus === null || !order.includes(selection.focus)) return { names: [], anchor: null, focus: null };
  return selectSingle(selection, order, selection.focus);
}

/** Moves only the keyboard focus (focus by mouse or Tab), the selected names stay. */
export function focusOnly(selection: Selection, order: readonly string[], name: string): Selection {
  if (!order.includes(name) || selection.focus === name) return selection;
  return { ...selection, focus: name };
}

/**
 * After a reload or a new sort order: drops names that no longer exist and restores the
 * display order. A missing focus falls back to the first remaining selected name, a missing
 * anchor to the focus.
 */
export function prune(selection: Selection, order: readonly string[]): Selection {
  const names = inOrder(order, selection.names);
  const focus = selection.focus !== null && order.includes(selection.focus) ? selection.focus : names[0] ?? null;
  const anchor = selection.anchor !== null && order.includes(selection.anchor) ? selection.anchor : focus;
  const unchanged = focus === selection.focus && anchor === selection.anchor && names.length === selection.names.length && names.every((name, index) => name === selection.names[index]);
  return unchanged ? selection : { names, anchor, focus };
}
