import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDialog } from "./SessionDialog";
import type { SavedSession } from "../lib/sessions";
import type { PasteChoice } from "../lib/paste";

// Indexed hook state so a re-render sees what the previous render set; no DOM renderer needed.
const host = vi.hoisted(() => ({ states: [] as unknown[], index: 0 }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: vi.fn(),
  useId: () => "test-session",
  useRef: (current: unknown) => ({ current }),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useReducer: (_reducer: unknown, initial: unknown) => [initial, vi.fn()],
  useState: (initial: unknown) => {
    const index = host.index++;
    if (!(index in host.states)) host.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [host.states[index], (value: unknown) => { host.states[index] = value; }];
  },
}));
vi.mock("./useModal", () => ({ useModal: () => ({ current: null }) }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as ReactNode)] : []);
}
const status = (tree: ReactNode) => elements(tree).find(node => node.props.role === "status");
const resetButton = (tree: ReactNode) => elements(tree).find(node => node.type === "button" && node.props.children === "Gemerkte Einfüge-Auswahl zurücksetzen");

const saved: SavedSession = { kind: "ssh", id: "s1", name: "Server", folder: "", host: "localhost", port: 22, user: null, auth: { type: "default" }, source: null };
const render = (props: { session?: SavedSession; rememberedPaste?: PasteChoice | null; onResetPaste?: () => void }) => {
  host.index = 0;
  return SessionDialog({ sessions: [], onClose: vi.fn(), onSaved: vi.fn(), ...props });
};

beforeEach(() => { host.states = []; host.index = 0; });

describe("remembered paste choice in the session dialog", () => {
  it("is hidden without a remembered choice or for a new session", () => {
    const onResetPaste = vi.fn();
    expect(status(render({ session: saved, rememberedPaste: null, onResetPaste }))).toBeUndefined();
    host.states = [];
    expect(status(render({ session: saved, onResetPaste }))).toBeUndefined();
    host.states = [];
    expect(status(render({ session: { ...saved, id: "" }, rememberedPaste: { action: "paste", trim: false }, onResetPaste }))).toBeUndefined();
    host.states = [];
    expect(resetButton(render({ rememberedPaste: { action: "paste", trim: false }, onResetPaste }))).toBeUndefined();
  });

  it("describes the choice including the trimmed line break", () => {
    expect(status(render({ session: saved, rememberedPaste: { action: "paste", trim: false }, onResetPaste: vi.fn() }))?.props.children).toBe("Gemerkt: Einfügen");
    host.states = [];
    expect(status(render({ session: saved, rememberedPaste: { action: "single-line", trim: true }, onResetPaste: vi.fn() }))?.props.children)
      .toBe("Gemerkt: Als eine Zeile, letzten Zeilenumbruch entfernen");
  });

  it("resets right away, keeps the line and follows the prop afterwards", () => {
    const onResetPaste = vi.fn();
    const choice: PasteChoice = { action: "single-line", trim: false };
    const button = resetButton(render({ session: saved, rememberedPaste: choice, onResetPaste }))!;
    expect(button.props.disabled).toBe(false);
    expect(button.props.title).toBe("Eine für einen offenen Tab gemerkte Auswahl bleibt bis zum Schließen des Tabs bestehen");
    (button.props.onClick as () => void)();
    expect(onResetPaste).toHaveBeenCalledOnce();
    let tree = render({ session: saved, rememberedPaste: null, onResetPaste });
    expect(status(tree)?.props.children).toBe("Nichts gemerkt");
    expect(status(tree)?.props.tabIndex).toBe(-1);
    expect(resetButton(tree)?.props.disabled).toBe(true);
    tree = render({ session: saved, rememberedPaste: { action: "paste", trim: true }, onResetPaste });
    expect(status(tree)?.props.children).toBe("Gemerkt: Einfügen, letzten Zeilenumbruch entfernen");
    expect(resetButton(tree)?.props.disabled).toBe(false);
  });

  it("moves focus to the status line after the reset", () => {
    const focus = vi.fn();
    const tree = render({ session: saved, rememberedPaste: { action: "paste", trim: false }, onResetPaste: vi.fn() });
    (status(tree)!.props.ref as { current: unknown }).current = { focus };
    (resetButton(tree)!.props.onClick as () => void)();
    expect(focus).toHaveBeenCalledOnce();
  });
});
