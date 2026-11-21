import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterAll, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionsPanel } from "./SessionsPanel";
import type { SavedSession } from "../lib/sessions";
import { invoke } from "@tauri-apps/api/core";

const host = vi.hoisted(() => ({ ids: [] as string[], index: 0, context: null as unknown, export: vi.fn() }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const index = host.index++;
    if (index === 7) return [host.context, vi.fn()];
    const value = typeof initial === "function" ? initial() : initial;
    return [value && typeof value === "object" && "ids" in value ? { ids: host.ids, anchor: "" } : value, vi.fn()];
  },
}));
vi.mock("../lib/sessionExport", () => ({ chooseSessionExport: host.export }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
afterAll(() => vi.unstubAllGlobals());
const sessions: SavedSession[] = ["one", "two"].map(id => ({
  kind: "ssh", id, name: id, folder: "", host: "example.test", port: 22,
  user: null, auth: { type: "default" }, source: null,
}));
it.each([0, 1, 2])("shows the selection count only for multiple sessions (%s)", count => {
  host.ids = sessions.slice(0, count).map(session => session.id);
  const noop = () => {};
  host.index = 0; host.context = null;
  const html = renderToStaticMarkup(<SessionsPanel sessions={sessions} onConnect={noop} onEdit={noop} onReload={noop} onStatus={noop} />);
  expect(html.includes("ausgewählt")).toBe(count >= 2);
  expect(html).toContain('aria-label="Importieren"');
  expect(html).toContain('aria-label="Exportieren"');
  expect(html).not.toContain(">Importieren</button>");
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as ReactNode)] : []);
}
function panel(context: unknown, ids: string[] = []) {
  host.index = 0; host.context = context; host.ids = ids;
  vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
  return SessionsPanel({ sessions, onConnect() {}, onEdit() {}, onReload() {}, onStatus() {} });
}
it.each([1, 2])("exports a session context selection (%s)", count => {
  const tree = panel({ x: 10, y: 10, row: { key: "session:one", depth: 0, session: sessions[0] } }, sessions.slice(0, count).map(s => s.id));
  const button = elements(tree).find(item => item.type === "button" && item.props.children === (count === 1 ? "Sitzung exportieren…" : "2 Sitzungen exportieren…"))!;
  expect(button).toBeDefined();
  (button.props.onClick as () => void)();
  expect(host.export).toHaveBeenLastCalledWith(sessions.slice(0, count).map(s => s.id), expect.any(Function));
});
it("exports every session in a folder including subfolders", () => {
  const grouped = sessions.map((session, index) => ({ ...session, folder: index ? "Work/Sub" : "Work" }));
  host.index = 0; host.ids = []; host.context = { x: 10, y: 10, row: { key: "folder:Work", depth: 0, folder: { name: "Work", path: "Work", sessions: [], folders: [] } } };
  vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
  const tree = SessionsPanel({ sessions: grouped, onConnect() {}, onEdit() {}, onReload() {}, onStatus() {} });
  const button = elements(tree).find(item => item.type === "button" && item.props.children === "Ordner exportieren…")!;
  expect(button).toBeDefined(); (button.props.onClick as () => void)();
  expect(host.export).toHaveBeenLastCalledWith(["one", "two"], expect.any(Function));
});
it.each([[[]], [["one"]]])("exports all or the selected sessions from the toolbar (%j)", ids => {
  const tree = panel(null, ids);
  const button = elements(tree).find(item => item.type === "button" && item.props["aria-label"] === "Exportieren")!;
  (button.props.onClick as () => void)();
  expect(host.export).toHaveBeenLastCalledWith(ids, expect.any(Function));
});

type Handler = (event: unknown) => void;
// Children.toArray escapes ":" in keys as "=2".
function dragSetup(target: string | null) {
  const grouped = [{ ...sessions[0], folder: "" }, { ...sessions[1], folder: "Work" }];
  host.index = 0; host.context = null; host.ids = ["one"];
  vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800, setTimeout: vi.fn() });
  vi.stubGlobal("document", { elementFromPoint: vi.fn(() => ({ closest: (selector: string) => selector === "[data-drop-folder]" && target !== null ? { getAttribute: () => target } : null })) });
  vi.mocked(invoke).mockClear();
  const written = vi.fn(); const undoable = vi.fn();
  const tree = SessionsPanel({ sessions: grouped, onConnect() {}, onEdit() {}, onReload() {}, onStatus() {}, onWritten: written, onUndoable: undoable });
  const row = (key: string) => elements(tree).find(item => String(item.key).endsWith("$" + key.replace(":", "=2")))!.props as Record<string, Handler>;
  const capture = { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() };
  const at = (x: number, y: number, buttons = 1) => ({ button: 0, buttons, pointerId: 1, clientX: x, clientY: y, currentTarget: capture });
  return { row, capture, at, written, undoable };
}
it("drags the selected session onto a folder with the pointer and offers undo", async () => {
  const { row, capture, at, written, undoable } = dragSetup("Work");
  const undo = { sessions: [{ id: "one", folder: "", expected: "Work" }], added: [], removed: [] };
  vi.mocked(invoke).mockResolvedValueOnce({ changed: true, moved: 1, undo });
  const one = row("session:one");
  one.onPointerDown(at(10, 10));
  one.onPointerMove(at(12, 12));
  expect(capture.setPointerCapture).not.toHaveBeenCalled();
  one.onPointerMove(at(10, 40));
  expect(capture.setPointerCapture).toHaveBeenCalledWith(1);
  one.onPointerUp(at(10, 40));
  expect(capture.releasePointerCapture).toHaveBeenCalledWith(1);
  expect(invoke).toHaveBeenCalledWith("sessions_move", { ids: ["one"], folder: "Work" });
  await vi.waitFor(() => expect(undoable).toHaveBeenCalledWith("1 Sitzung nach Work verschoben", expect.any(Function)));
  expect(written).toHaveBeenCalled();
  (undoable.mock.calls[0][1] as () => void)();
  expect(invoke).toHaveBeenLastCalledWith("sessions_restore_layout", { layout: undo });
});
it("does not move on a short press, a cancelled drag or a drop into the own folder", () => {
  const press = dragSetup("Work");
  const one = press.row("session:one");
  one.onPointerDown(press.at(10, 10)); one.onPointerUp(press.at(11, 11));
  one.onPointerDown(press.at(10, 10)); one.onPointerMove(press.at(10, 40)); one.onPointerCancel(undefined); one.onPointerUp(press.at(10, 40));
  const own = dragSetup("Work");
  const work = own.row("folder:Work");
  work.onPointerDown(own.at(10, 10)); work.onPointerMove(own.at(10, 40)); work.onPointerUp(own.at(10, 40));
  const outside = dragSetup(null);
  const other = outside.row("session:one");
  other.onPointerDown(outside.at(10, 10)); other.onPointerMove(outside.at(10, 40)); other.onPointerUp(outside.at(10, 40));
  expect(invoke).not.toHaveBeenCalled();
});
it("ends a press whose button was released elsewhere and releases the capture after a cancelled drag", () => {
  const { row, capture, at } = dragSetup("Work");
  const one = row("session:one");
  // Released outside the row: the next move without a pressed button ends the press for good.
  one.onPointerDown(at(10, 10)); one.onPointerMove(at(10, 12, 0)); one.onPointerMove(at(10, 40)); one.onPointerUp(at(10, 40));
  expect(capture.setPointerCapture).not.toHaveBeenCalled();
  // Cancelled while dragging (Escape, blur, pointercancel): the next pointerup only releases the capture.
  one.onPointerDown(at(10, 10)); one.onPointerMove(at(10, 40));
  expect(capture.setPointerCapture).toHaveBeenCalledTimes(1);
  one.onPointerCancel(undefined);
  one.onPointerUp(at(10, 40));
  expect(capture.releasePointerCapture).toHaveBeenCalledWith(1);
  expect(invoke).not.toHaveBeenCalled();
});
