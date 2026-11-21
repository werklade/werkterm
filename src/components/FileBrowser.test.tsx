import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { FileBrowser, type BrowserTab } from "./FileBrowser";
import { InlineRename } from "./InlineRename";
import { BrowserContextMenu } from "./BrowserContextMenu";
import type { DirListing } from "../lib/fs";
import { defaultSettings } from "../lib/settings";

// useState call order in FileBrowser: widths, sudoActive, browserMode, listing, input, loading, error, revision,
// selected, renaming, context, uploadMenu, sort, busy, ...
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
vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
afterAll(() => vi.unstubAllGlobals());

const listing: DirListing = {
  path: "/srv", mode: "sftp", entries: [
    { name: "notes.txt", kind: "file", size: 1, permissions: 0o644, modified: null, targetIsDir: false },
    { name: "www", kind: "dir", size: 0, permissions: 0o755, modified: null, targetIsDir: false },
  ],
};
const tab: BrowserTab = { id: 1, kind: "ssh", title: "srv", sessionId: 7, browserPath: "/srv", exited: false };
type Element = ReactElement<Record<string, unknown>>;
type Handler = (event: unknown) => void;
function elements(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as ReactNode)] : []);
}
function browser(state: Record<number, unknown>, browserTab: BrowserTab = tab) {
  host.index = 0; host.refIndex = 0;
  host.state = { [LISTING]: listing, ...state };
  const onStatus = vi.fn(), onPath = vi.fn();
  const tree = FileBrowser({
    tab: browserTab, settings: defaultSettings, onSettings() {}, onPath, onAccess() {}, onStatus, onOpenFile() {},
    transferQueue: { enqueue: vi.fn(), onFinished: () => () => {} } as never,
  });
  const all = elements(tree);
  const renameButton = all.find(item => item.type === "button" && item.props["aria-label"] === "Umbenennen")!;
  const row = (name: string) => all.find(item => item.type === "tr" && String(item.key).endsWith("$" + name))!;
  return { all, renameButton, row, onStatus, onPath };
}
const key = (key: string) => ({ key, preventDefault: vi.fn(), currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } });
beforeEach(() => { vi.mocked(invoke).mockClear(); host.refs = {}; });
/** Starts editing via the toolbar, then renders the next state with the name field shown. */
function editing() {
  (browser({ [SELECTED]: "notes.txt" }).renameButton.props.onClick as Handler)({});
  const view = browser({ [SELECTED]: "notes.txt", [RENAMING]: "notes.txt" });
  const field = view.all.find(item => item.type === InlineRename)!;
  return { ...view, done: field.props.onDone as (value: string | null) => void };
}

it("places the rename button right after delete and enables it only with a selection in a writable listing", () => {
  const { all, renameButton } = browser({});
  const labels = all.filter(item => item.type === "button" && item.props["aria-label"]).map(item => item.props["aria-label"]);
  expect(labels.indexOf("Umbenennen")).toBe(labels.indexOf("Löschen") + 1);
  expect(renameButton.props.disabled).toBe(true);
  expect(browser({ [SELECTED]: "notes.txt" }).renameButton.props.disabled).toBe(false);
  expect(browser({ [SELECTED]: "notes.txt", [BUSY]: true }).renameButton.props.disabled).toBe(true);
  expect(browser({ [SELECTED]: "notes.txt", [LISTING]: { ...listing, mode: "exec" } }).renameButton.props.disabled).toBe(true);
  expect(browser({ [SELECTED]: "notes.txt", [LISTING]: { ...listing, mode: "local" } }, { ...tab, kind: "local" }).renameButton.props.disabled).toBe(true);
});

it("starts editing in place from the toolbar button and from F2 on the row", () => {
  const view = browser({ [SELECTED]: "notes.txt" });
  (view.renameButton.props.onClick as Handler)({});
  expect(host.setters[RENAMING]).toHaveBeenCalledWith("notes.txt");
  const f2 = browser({ [SELECTED]: "notes.txt" });
  const event = key("F2");
  (f2.row("www").props.onKeyDown as Handler)(event);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(host.setters[SELECTED]).toHaveBeenCalledWith("www");
  expect(host.setters[RENAMING]).toHaveBeenCalledWith("www");
});

it("does not start editing with F2 in a read-only listing", () => {
  const view = browser({ [SELECTED]: "notes.txt", [LISTING]: { ...listing, mode: "exec" } });
  (view.row("notes.txt").props.onKeyDown as Handler)(key("F2"));
  expect(host.setters[RENAMING]).not.toHaveBeenCalled();
});

it("keeps Enter (open) and Delete (ask) on the row unchanged", () => {
  const view = browser({ [SELECTED]: "www" });
  (view.row("www").props.onKeyDown as Handler)(key("Enter"));
  expect(view.onPath).toHaveBeenCalledWith(1, "/srv/www");
  const file = browser({ [SELECTED]: "notes.txt" });
  (file.row("notes.txt").props.onKeyDown as Handler)(key("Delete"));
  expect(host.setters[15]).toHaveBeenCalledWith(expect.objectContaining({ type: "delete" })); // confirmation prompt
  expect(host.setters[RENAMING]).not.toHaveBeenCalled();
});

it("shows the name field only for the entry being renamed", () => {
  const { all } = browser({ [SELECTED]: "notes.txt", [RENAMING]: "notes.txt" });
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
  const writable = browser({ [SELECTED]: "notes.txt", [CONTEXT]: { entry, x: 1, y: 1 } }).all.find(item => item.type === BrowserContextMenu)!;
  expect(writable.props.renameDisabled).toBe(false);
  const readOnly = browser({ [SELECTED]: "notes.txt", [CONTEXT]: { entry, x: 1, y: 1 }, [LISTING]: { ...listing, mode: "exec" } }).all.find(item => item.type === BrowserContextMenu)!;
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
