import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { ColorRow, DesignEditor, parseDesignColor } from "./DesignEditor";
import { getDesign } from "../lib/designs";
const host = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as { current: unknown }[], refIndex: 0, stored: [] as { id: string; design: unknown }[], index: 0, invoke: vi.fn(), register: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: vi.fn(), useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(), useRef: (current: unknown) => { const index = host.refIndex++; return host.refs[index] ?? (host.refs[index] = { current }); }, useState: (initial: unknown) => { const index = host.index++; if (!(index in host.states)) host.states[index] = typeof initial === "function" ? initial() : initial; return [host.states[index], (value: unknown) => { host.states[index] = value; }]; } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: host.invoke }));
vi.mock("../lib/designs", async original => ({ ...await original<typeof import("../lib/designs")>(), applyDesign: vi.fn(), registerUserDesign: host.register, getUserDesigns: () => host.stored }));
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] { return Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as ReactNode)] : []); }
beforeEach(() => { host.states = []; host.refs = []; host.refIndex = 0; host.stored = []; host.index = 0; vi.clearAllMocks(); host.invoke.mockResolvedValue("copy-id"); host.register.mockImplementation((id, design) => { host.stored = [{ id, design }]; }); vi.useFakeTimers(); });
it("creates and selects a user copy when a built-in color is edited", async () => {
  const changed = vi.fn();
  const tree = DesignEditor({ name: "Werklade Dunkel", onChange: changed });
  const row = elements(tree).find(node => node.type === ColorRow && node.props.token === "bg-app")!;
  (row.props.onChange as (color: string) => void)("#123456");
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith("Werklade Dunkel (Kopie)"));
  expect(host.invoke).toHaveBeenCalledWith("designs_save", { id: null, design: expect.objectContaining({ name: "Werklade Dunkel (Kopie)", ui: expect.objectContaining({ "bg-app": "#123456" }) }) });
  expect(getDesign("Werklade Dunkel").ui["bg-app"]).toBe("#1f2933");
  host.index = 0; host.refIndex = 0; host.states[0] = host.stored;
  const copyTree = DesignEditor({ name: "Werklade Dunkel (Kopie)", onChange: changed });
  const reset = elements(copyTree).find(node => node.type === "button" && node.props.children === "Zurücksetzen")!;
  (reset.props.onClick as () => void)();
  await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledWith("designs_save", { id: "copy-id", design: expect.objectContaining({ name: "Werklade Dunkel (Kopie)", ui: expect.objectContaining({ "bg-app": "#1f2933" }) }) }));
  vi.clearAllTimers(); vi.useRealTimers();
});
it("shows an inline error and does not apply invalid hex input", () => {
  const changed = vi.fn();
  let tree = ColorRow({ token: "accent", value: "#123456", onChange: changed });
  const input = elements(tree).find(node => node.type === "input" && node.props["aria-label"] === "Akzent Hex")!;
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "#xyz" } });
  host.index = 0;
  tree = ColorRow({ token: "accent", value: "#123456", onChange: changed });
  expect(elements(tree).some(node => node.props.role === "alert" && node.props.children === "Ungültige Hex-Farbe")).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  vi.useRealTimers();
});
it("expands short hex while preserving alpha in full hex", () => { expect(parseDesignColor("#aBc")).toBe("#aabbcc"); expect(parseDesignColor("#ABCDEF80")).toBe("#abcdef80"); expect(parseDesignColor("red")).toBeUndefined(); });
