import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { FileBrowser, type BrowserTab } from "./FileBrowser";
import { InlineRename } from "./InlineRename";
import { BrowserContextMenu } from "./BrowserContextMenu";
import type { DirListing } from "../lib/fs";
import { defaultSettings } from "../lib/settings";
import type { Selection } from "../lib/browserSelection";

// useState call order in FileBrowser: widths, sudoActive, browserMode, listing, input, loading, error, revision,
// selection, renaming, context, uploadMenu, sort, busy, dragOver, prompt, ...
const LISTING = 3, SELECTED = 8, RENAMING = 9, CONTEXT = 10, BUSY = 13;
const host = vi.hoisted(() => ({ index: 0, refIndex: 0, state: {} as Record<number, unknown>, setters: {} as Record<number, ReturnType<typeof vi.fn>>, refs: {} as Record<number, { current: unknown }> }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  // Refs persist across the renders of one test, like in a mounted component.
  useRef: (current: unknown) => { const index = host.refIndex++; return host.refs[index] ??= { current }; },
  useState: (initial: unknown) => {
    const index = host.index++;
    const value = index in host.state ? host.state[index] : typeof initial === "function" ? (initial as () => unknown)() : initial;
    host.setters[index] = vi.fn();
    return [value, host.setters[index]];
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn().mockResolvedValue(() => {}) }) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ scaleFactor: vi.fn().mockResolvedValue(1) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ sep: () => "/" }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
afterAll(() => vi.unstubAllGlobals());

const listing: DirListing = {
  path: "/srv", mode: "sftp", entries: [
    { name: "notes.txt", kind: "file", size: 1, permissions: 0o644, modified: null, targetIsDir: false },
    { name: "www", kind: "dir", size: 0, permissions: 0o755, modified: null, targetIsDir: false },
  ],
};
/** Single selection of `names[0]`, or the given names with anchor/focus on the first. */
const sel = (...names: string[]): Selection => ({ names, anchor: names[0] ?? null, focus: names[0] ?? null });
const tab: BrowserTab = { id: 1, kind: "ssh", title: "srv", sessionId: 7, browserPath: "/srv", exited: false };
type Element = ReactElement<Record<string, unknown>>;
type Handler = (event: unknown) => void;
function elements(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as ReactNode)] : []);
}
function browser(state: Record<number, unknown>, browserTab: BrowserTab = tab) {
  host.index = 0; host.refIndex = 0;
  host.state = { [LISTING]: listing, ...state };
  const onStatus = vi.fn(), onPath = vi.fn(), onOpenFile = vi.fn(), enqueue = vi.fn();
  const tree = FileBrowser({
    tab: browserTab, settings: defaultSettings, onSettings() {}, onPath, onAccess() {}, onStatus, onOpenFile,
    transferQueue: { enqueue, onFinished: () => () => {} } as never,
  });
  const all = elements(tree);
  const renameButton = all.find(item => item.type === "button" && item.props["aria-label"] === "Umbenennen")!;
  const row = (name: string) => all.find(item => item.type === "tr" && String(item.key).endsWith("$" + name))!;
  const button = (label: string) => all.find(item => item.type === "button" && item.props["aria-label"] === label)!;
  return { all, renameButton, button, row, onStatus, onPath, onOpenFile, enqueue };
}
const key = (key: string) => ({ key, preventDefault: vi.fn(), currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } });
beforeEach(() => { vi.mocked(invoke).mockReset(); vi.mocked(invoke).mockResolvedValue(undefined); host.refs = {}; });
/** Starts editing via the toolbar, then renders the next state with the name field shown. */
function editing() {
  (browser({ [SELECTED]: sel("notes.txt") }).renameButton.props.onClick as Handler)({});
  const view = browser({ [SELECTED]: sel("notes.txt"), [RENAMING]: "notes.txt" });
  const field = view.all.find(item => item.type === InlineRename)!;
  return { ...view, done: field.props.onDone as (value: string | null) => void };
}

it("places the rename button right after delete and enables it only with a selection in a writable listing", () => {
  const { all, renameButton } = browser({});
  const labels = all.filter(item => item.type === "button" && item.props["aria-label"]).map(item => item.props["aria-label"]);
  expect(labels.indexOf("Umbenennen")).toBe(labels.indexOf("Löschen") + 1);
  expect(renameButton.props.disabled).toBe(true);
  expect(browser({ [SELECTED]: sel("notes.txt") }).renameButton.props.disabled).toBe(false);
  expect(browser({ [SELECTED]: sel("notes.txt"), [BUSY]: true }).renameButton.props.disabled).toBe(true);
  expect(browser({ [SELECTED]: sel("notes.txt"), [LISTING]: { ...listing, mode: "exec" } }).renameButton.props.disabled).toBe(true);
  expect(browser({ [SELECTED]: sel("notes.txt"), [LISTING]: { ...listing, mode: "local" } }, { ...tab, kind: "local" }).renameButton.props.disabled).toBe(true);
});

it("starts editing in place from the toolbar button and from F2 on the row", () => {
  const view = browser({ [SELECTED]: sel("notes.txt") });
  (view.renameButton.props.onClick as Handler)({});
  expect(host.setters[RENAMING]).toHaveBeenCalledWith("notes.txt");
  const f2 = browser({ [SELECTED]: sel("notes.txt") });
  const event = key("F2");
  (f2.row("www").props.onKeyDown as Handler)(event);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(host.setters[SELECTED]).toHaveBeenCalledWith(sel("www"));
  expect(host.setters[RENAMING]).toHaveBeenCalledWith("www");
});

it("does not start editing with F2 in a read-only listing", () => {
  const view = browser({ [SELECTED]: sel("notes.txt"), [LISTING]: { ...listing, mode: "exec" } });
  (view.row("notes.txt").props.onKeyDown as Handler)(key("F2"));
  expect(host.setters[RENAMING]).not.toHaveBeenCalled();
});

it("keeps Enter (open) and Delete (ask) on the row unchanged", () => {
  const view = browser({ [SELECTED]: sel("www") });
  (view.row("www").props.onKeyDown as Handler)(key("Enter"));
  expect(view.onPath).toHaveBeenCalledWith(1, "/srv/www");
  const file = browser({ [SELECTED]: sel("notes.txt") });
  (file.row("notes.txt").props.onKeyDown as Handler)(key("Delete"));
  expect(host.setters[15]).toHaveBeenCalledWith(expect.objectContaining({ type: "delete" })); // confirmation prompt
  expect(host.setters[RENAMING]).not.toHaveBeenCalled();
});

it("shows the name field only for the entry being renamed", () => {
  const { all } = browser({ [SELECTED]: sel("notes.txt"), [RENAMING]: "notes.txt" });
  const fields = all.filter(item => item.type === InlineRename);
  expect(fields).toHaveLength(1);
  expect(fields[0].props).toMatchObject({ name: "notes.txt", file: true, label: "Neuer Name für notes.txt" });
});

it("renames through the backend, reloads and keeps the renamed entry selected", async () => {
  const { done, onStatus } = editing();
  done("notes2.txt");
  expect(host.setters[RENAMING]).toHaveBeenCalledWith(null);
  expect(invoke).toHaveBeenCalledWith("ssh_rename", { id: 7, parent: "/srv", name: "notes.txt", newName: "notes2.txt" });
  await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("notes.txt in notes2.txt umbenannt"));
  await vi.waitFor(() => expect(host.setters[7]).toHaveBeenCalled()); // revision: reload the listing
  expect(Object.values(host.refs).some(ref => ref.current === "notes2.txt")).toBe(true);
  // A blur reported after the field was removed does not rename a second time.
  done("notes2.txt");
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("cancels with Escape and applies nothing for an unchanged name", () => {
  editing().done(null);
  expect(host.setters[RENAMING]).toHaveBeenCalledWith(null);
  editing().done("notes.txt");
  expect(invoke).not.toHaveBeenCalled();
});

it("reports an invalid name without calling the backend", () => {
  const { done } = editing();
  done("sub/notes.txt");
  expect(invoke).not.toHaveBeenCalled();
  expect(host.setters[6]).toHaveBeenCalledWith("Ungültiger Name"); // error line
});

it("shows backend errors such as an existing target in the error line", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(`EXISTS: ${JSON.stringify({ args: { name: "www" } })}`);
  const { done, onStatus } = editing();
  done("www");
  await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("www existiert bereits"));
  expect(host.setters[6]).toHaveBeenCalledWith("www existiert bereits");
});

it("offers Rename with F2 in the context menu, disabled without SFTP", () => {
  const entry = listing.entries[0];
  const writable = browser({ [SELECTED]: sel("notes.txt"), [CONTEXT]: { entry, x: 1, y: 1 } }).all.find(item => item.type === BrowserContextMenu)!;
  expect(writable.props.renameDisabled).toBe(false);
  const readOnly = browser({ [SELECTED]: sel("notes.txt"), [CONTEXT]: { entry, x: 1, y: 1 }, [LISTING]: { ...listing, mode: "exec" } }).all.find(item => item.type === BrowserContextMenu)!;
  expect(readOnly.props.renameDisabled).toBe(true);
});

it("lists Rename with the F2 shortcut before Delete in the context menu", () => {
  host.index = 0; host.refIndex = 0;
  vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
  const menu = BrowserContextMenu({ entry: listing.entries[0], x: 1, y: 1, onAnswer() {} }) as Element;
  const items = menu.props.items as { action: string; label: string; shortcut?: string; disabled?: boolean }[];
  const index = items.findIndex(item => item.action === "rename");
  expect(items[index]).toMatchObject({ label: "Umbenennen", shortcut: "F2" });
  expect(items[index + 1].action).toBe("delete");
  const rendered = elements((menu.type as (props: unknown) => ReactNode)(menu.props));
  const button = rendered.find(item => item.type === "button" && item.props["aria-keyshortcuts"] === "F2")!;
  expect(elements(button.props.children as ReactNode).find(item => item.type === "kbd")?.props.children).toBe("F2");
});

// Multi-selection (issue #34). Display order: folder "logs" first, then the files by name.
const PROMPT = 15;
const many: DirListing = {
  path: "/srv", mode: "sftp", entries: [
    { name: "b.txt", kind: "file", size: 1, permissions: 0o644, modified: null, targetIsDir: false },
    { name: "a.txt", kind: "file", size: 1, permissions: 0o644, modified: null, targetIsDir: false },
    { name: "logs", kind: "dir", size: 0, permissions: 0o755, modified: null, targetIsDir: false },
    { name: "c.txt", kind: "file", size: 1, permissions: 0o600, modified: null, targetIsDir: false },
  ],
};
const multi = (state: Record<number, unknown>) => browser({ [LISTING]: many, ...state });
const click = (modifiers: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}) => ({ ctrlKey: false, shiftKey: false, metaKey: false, ...modifiers });
const press = (name: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => ({ ...key(name), ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });
const selectionSet = () => host.setters[SELECTED].mock.calls.slice(-1)[0]?.[0] as Selection;
const prompted = () => host.setters[PROMPT].mock.calls.slice(-1)[0]?.[0] as { type: string; message?: string; count?: number; anyDir?: boolean; answer: (value: unknown) => void };

it("marks the list as multi-selectable and every selected row", () => {
  const view = multi({ [SELECTED]: { names: ["a.txt", "c.txt"], anchor: "a.txt", focus: "c.txt" } });
  expect(view.all.find(item => item.type === "table")!.props).toMatchObject({ role: "grid", "aria-multiselectable": "true" });
  expect(view.row("a.txt").props["aria-selected"]).toBe(true);
  expect(view.row("b.txt").props["aria-selected"]).toBe(false);
  expect(view.row("c.txt").props["aria-selected"]).toBe(true);
  // Roving tabindex follows the focus, not the first selected row.
  expect(view.row("c.txt").props.tabIndex).toBe(0);
  expect(view.row("a.txt").props.tabIndex).toBe(-1);
});

it("selects with click, toggles with Ctrl or Cmd and selects a range with Shift", () => {
  (multi({ [SELECTED]: sel("a.txt") }).row("c.txt").props.onClick as Handler)(click());
  expect(selectionSet()).toEqual(sel("c.txt"));
  (multi({ [SELECTED]: sel("a.txt") }).row("c.txt").props.onClick as Handler)(click({ ctrlKey: true }));
  expect(selectionSet()).toEqual({ names: ["a.txt", "c.txt"], anchor: "c.txt", focus: "c.txt" });
  (multi({ [SELECTED]: { names: ["a.txt", "c.txt"], anchor: "c.txt", focus: "c.txt" } }).row("a.txt").props.onClick as Handler)(click({ metaKey: true }));
  expect(selectionSet()).toEqual({ names: ["c.txt"], anchor: "a.txt", focus: "a.txt" });
  (multi({ [SELECTED]: sel("logs") }).row("b.txt").props.onClick as Handler)(click({ shiftKey: true }));
  expect(selectionSet()).toEqual({ names: ["logs", "a.txt", "b.txt"], anchor: "logs", focus: "b.txt" });
});

it("extends the selection with Shift+arrow, Shift+End and moves it without Shift", () => {
  (multi({ [SELECTED]: sel("a.txt") }).row("a.txt").props.onKeyDown as Handler)(press("ArrowDown", { shiftKey: true }));
  expect(selectionSet()).toEqual({ names: ["a.txt", "b.txt"], anchor: "a.txt", focus: "b.txt" });
  (multi({ [SELECTED]: { names: ["a.txt", "b.txt"], anchor: "a.txt", focus: "b.txt" } }).row("b.txt").props.onKeyDown as Handler)(press("End", { shiftKey: true }));
  expect(selectionSet()).toEqual({ names: ["a.txt", "b.txt", "c.txt"], anchor: "a.txt", focus: "c.txt" });
  (multi({ [SELECTED]: { names: ["a.txt", "b.txt"], anchor: "a.txt", focus: "b.txt" } }).row("b.txt").props.onKeyDown as Handler)(press("ArrowUp"));
  expect(selectionSet()).toEqual(sel("a.txt"));
  (multi({ [SELECTED]: sel("c.txt") }).row("c.txt").props.onKeyDown as Handler)(press("Home"));
  expect(selectionSet()).toEqual(sel("logs"));
});

it("selects everything with Ctrl+A and keeps only the focused entry with Escape", () => {
  const event = press("a", { ctrlKey: true });
  (multi({ [SELECTED]: sel("b.txt") }).row("b.txt").props.onKeyDown as Handler)(event);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(selectionSet()).toEqual({ names: ["logs", "a.txt", "b.txt", "c.txt"], anchor: "b.txt", focus: "b.txt" });
  (multi({ [SELECTED]: { names: ["logs", "a.txt", "b.txt"], anchor: "logs", focus: "b.txt" } }).row("b.txt").props.onKeyDown as Handler)(press("Escape"));
  expect(selectionSet()).toEqual(sel("b.txt"));
});

it("drops vanished entries after a reload without losing the others", () => {
  const view = multi({ [SELECTED]: { names: ["gone.txt", "a.txt", "c.txt"], anchor: "gone.txt", focus: "gone.txt" } });
  expect(view.row("a.txt").props["aria-selected"]).toBe(true);
  expect(view.row("a.txt").props.tabIndex).toBe(0); // focus falls back to the first remaining selected entry
  expect(view.all.find(item => item.type === "p" && item.props.className === "browser-selection-count")?.props.children).toBe("2 ausgewählt");
});

it("shows the count only for more than one selected entry", () => {
  const count = (selection: Selection) => multi({ [SELECTED]: selection }).all.find(item => item.type === "p" && item.props.className === "browser-selection-count");
  expect(count(sel("a.txt"))).toBeUndefined();
  expect(count({ names: ["a.txt", "b.txt", "c.txt"], anchor: "a.txt", focus: "a.txt" })?.props.children).toBe("3 ausgewählt");
});

it("disables rename and editor with several entries and says why; F2 does nothing", () => {
  const view = multi({ [SELECTED]: { names: ["a.txt", "b.txt"], anchor: "a.txt", focus: "b.txt" } });
  const edit = view.button("Im Editor öffnen");
  expect(view.renameButton.props).toMatchObject({ disabled: true, title: "Nur für einen einzelnen Eintrag verfügbar" });
  expect(edit.props).toMatchObject({ disabled: true, title: "Nur für einen einzelnen Eintrag verfügbar" });
  expect(view.button("Löschen").props.disabled).toBe(false);
  expect(view.button("Herunterladen").props.disabled).toBe(false);
  (view.row("b.txt").props.onKeyDown as Handler)(press("F2"));
  expect(host.setters[RENAMING]).not.toHaveBeenCalled();
  (edit.props.onClick as Handler)({});
  expect(view.onOpenFile).not.toHaveBeenCalled();
});

it("keeps the selection on right click of a selected entry and replaces it otherwise", () => {
  const selection = { names: ["a.txt", "b.txt"], anchor: "a.txt", focus: "a.txt" };
  const menu = () => ({ preventDefault: vi.fn(), clientX: 5, clientY: 6 });
  (multi({ [SELECTED]: selection }).row("b.txt").props.onContextMenu as Handler)(menu());
  expect(selectionSet()).toEqual({ ...selection, focus: "b.txt" });
  expect(host.setters[CONTEXT]).toHaveBeenCalledWith(expect.objectContaining({ x: 5, y: 6, count: 2 }));
  (multi({ [SELECTED]: selection }).row("c.txt").props.onContextMenu as Handler)(menu());
  expect(selectionSet()).toEqual(sel("c.txt"));
  expect(host.setters[CONTEXT]).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
  // The menu for several entries disables the single-entry actions.
  const props = multi({ [SELECTED]: selection, [CONTEXT]: { entry: many.entries[1], x: 1, y: 1, count: 2 } }).all.find(item => item.type === BrowserContextMenu)!.props;
  expect(props.count).toBe(2);
  host.index = 0; host.refIndex = 0;
  vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
  const rendered = BrowserContextMenu({ ...props, onAnswer() {} } as never) as Element;
  const items = rendered.props.items as { action: string; disabled?: boolean; title?: string }[];
  expect(rendered.props.label).toBe("Aktionen für 2 Einträge");
  expect(items.find(item => item.action === "rename")).toMatchObject({ disabled: true, title: "Nur für einen einzelnen Eintrag verfügbar" });
  expect(items.find(item => item.action === "edit")).toMatchObject({ disabled: true });
  expect(items.find(item => item.action === "delete")?.disabled).toBeFalsy();
});

it("downloads several entries into one chosen folder as one batch", async () => {
  const { open, save } = await import("@tauri-apps/plugin-dialog");
  vi.mocked(open).mockClear();
  vi.mocked(save).mockClear();
  vi.mocked(open).mockResolvedValueOnce("/home/me/dl/" as never);
  const view = multi({ [SELECTED]: { names: ["logs", "a.txt"], anchor: "logs", focus: "a.txt" } });
  (view.button("Herunterladen").props.onClick as Handler)({});
  await vi.waitFor(() => expect(view.enqueue).toHaveBeenCalledTimes(1));
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true, multiple: false, title: "Zielordner für 2 Einträge auswählen" }));
  expect(save).not.toHaveBeenCalled();
  expect(view.enqueue).toHaveBeenCalledWith([
    { kind: "downloadFolder", sessionId: 7, remotePath: "/srv/logs", localParent: "/home/me/dl/" },
    { kind: "download", sessionId: 7, remotePath: "/srv/a.txt", localPath: "/home/me/dl/a.txt", overwrite: false },
  ]);
});

it("keeps the save dialog for a single selected file", async () => {
  const { open, save } = await import("@tauri-apps/plugin-dialog");
  vi.mocked(open).mockClear();
  vi.mocked(save).mockResolvedValueOnce("/home/me/a.txt" as never);
  const view = multi({ [SELECTED]: sel("a.txt") });
  (view.button("Herunterladen").props.onClick as Handler)({});
  await vi.waitFor(() => expect(view.enqueue).toHaveBeenCalledWith([{ kind: "download", sessionId: 7, remotePath: "/srv/a.txt", localPath: "/home/me/a.txt" }]));
  expect(open).not.toHaveBeenCalled();
});

it("deletes several entries after one confirmation and reports failures", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "ssh_delete" && (args as { path: string }).path === "/srv/b.txt") throw "PERMISSION_DENIED";
    return undefined;
  });
  const view = multi({ [SELECTED]: { names: ["a.txt", "b.txt", "c.txt"], anchor: "a.txt", focus: "c.txt" } });
  (view.button("Löschen").props.onClick as Handler)({});
  await vi.waitFor(() => expect(host.setters[PROMPT]).toHaveBeenCalled());
  expect(host.setters[PROMPT]).toHaveBeenCalledTimes(1);
  expect(prompted()).toMatchObject({ type: "delete", message: "3 Einträge endgültig löschen (a.txt, b.txt, c.txt)?" });
  prompted().answer(true);
  await vi.waitFor(() => expect(view.onStatus).toHaveBeenCalledWith(expect.stringMatching(/^2 von 3 gelöscht · Fehler: b\.txt: /)));
  expect(vi.mocked(invoke).mock.calls.filter(call => call[0] === "ssh_delete").map(call => call[1])).toEqual([
    { id: 7, path: "/srv/a.txt", recursive: false }, { id: 7, path: "/srv/b.txt", recursive: false }, { id: 7, path: "/srv/c.txt", recursive: false },
  ]);
  await vi.waitFor(() => expect(host.setters[7]).toHaveBeenCalled()); // reload
});

it("names folders and their content in the multi-delete confirmation and deletes nothing on cancel", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "ssh_count_entries" ? 12 : undefined);
  const view = multi({ [SELECTED]: { names: ["logs", "a.txt", "b.txt", "c.txt"], anchor: "logs", focus: "c.txt" } });
  (view.button("Löschen").props.onClick as Handler)({});
  await vi.waitFor(() => expect(host.setters[PROMPT]).toHaveBeenCalled());
  expect(prompted().message).toBe("4 Einträge endgültig löschen (logs, a.txt, b.txt, …)? Ordner werden mit Inhalt gelöscht, enthaltene Einträge: 12.");
  prompted().answer(false);
  await vi.waitFor(() => expect(host.setters[7]).toHaveBeenCalled());
  expect(vi.mocked(invoke).mock.calls.some(call => call[0] === "ssh_delete")).toBe(false);
});

it("changes the permissions of several entries with one dialog", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "ssh_chmod" ? { changed: 1, failed: 0, errors: [] } : 3);
  const selection = { names: ["logs", "a.txt"], anchor: "logs", focus: "a.txt" };
  const view = multi({ [SELECTED]: selection, [CONTEXT]: { entry: many.entries[1], x: 1, y: 1, count: 2 } });
  (view.all.find(item => item.type === BrowserContextMenu)!.props.onAnswer as Handler)("chmod");
  await vi.waitFor(() => expect(host.setters[PROMPT]).toHaveBeenCalled());
  expect(prompted()).toMatchObject({ type: "permissions", count: 2, anyDir: true });
  prompted().answer({ mode: 0o750, recursive: true, scope: "all", dirMode: null, fileMode: null });
  // Recursive: one confirmation over all entries (3 inside logs + logs + a.txt).
  await vi.waitFor(() => expect(prompted()?.type).toBe("delete"));
  expect(prompted().message).toBe("5 Einträge ändern? Symlinks werden übersprungen.");
  prompted().answer(true);
  await vi.waitFor(() => expect(view.onStatus).toHaveBeenCalledWith("2 geändert, 0 fehlgeschlagen"));
  expect(vi.mocked(invoke).mock.calls.filter(call => call[0] === "ssh_chmod").map(call => call[1])).toEqual([
    { id: 7, path: "/srv/logs", mode: 0o750, recursive: true, scope: "all", dirMode: null, fileMode: null },
    { id: 7, path: "/srv/a.txt", mode: 0o750, recursive: false, scope: "all", dirMode: null, fileMode: null },
  ]);
});
