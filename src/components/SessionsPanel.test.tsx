import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterAll, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionsPanel } from "./SessionsPanel";
import type { SavedSession } from "../lib/sessions";

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
