import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { DataDirErrorDialog, DataDirForm, DataDirSection, RestartDialog, resetPointerNotice, restartNote, unreachableDefaultHint, type DataDirFormProps } from "./DataDirForm";
import { describeInspect, type DataDirInspect, type DataDirStatus } from "../lib/dataDir";

// Same approach as PasteDialog.test.tsx: only the hooks are replaced, the JSX is real.
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), useId: () => "test-datadir", useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));
vi.mock("./useModal", () => ({ useModal: () => ({ current: null }) }));

type Element = ReactElement<Record<string, unknown>>;
function findAll(node: ReactNode, predicate: (element: Element) => boolean, found: Element[] = []): Element[] {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (predicate(child)) found.push(child);
    findAll(child.props.children as ReactNode, predicate, found);
  }
  return found;
}
function textOf(node: ReactNode): string {
  return Children.toArray(node).map(child => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    return isValidElement<Record<string, unknown>>(child) ? textOf(child.props.children as ReactNode) : "";
  }).join("");
}
const buttons = (tree: ReactNode) => findAll(tree, e => e.type === "button");
const button = (tree: ReactNode, label: string) => buttons(tree).find(e => textOf(e.props.children as ReactNode) === label);
const labels = (tree: ReactNode) => buttons(tree).map(e => textOf(e.props.children as ReactNode));
const submits = (tree: ReactNode) => buttons(tree).filter(e => e.props.type === "submit");

const status: DataDirStatus = { configured: false, custom: false, path: "D:/Cloud/Werkterm", defaultPath: "C:/Users/test/AppData/Roaming/werkterm", reachable: true };
const info = (over: Partial<DataDirInspect> = {}): DataDirInspect => ({ exists: true, isDir: true, writable: true, hasData: false, sameAsCurrent: false, ...over });
const handlers = { onPick: vi.fn(), onDefault: vi.fn(), onCopy: vi.fn(), onSubmit: vi.fn(), onRetry: vi.fn(), onBack: vi.fn(), onCancel: vi.fn() };
const render = (over: Partial<DataDirFormProps> = {}) => DataDirForm({
  mode: "setup", view: "choose", status, choice: null, feedback: null, inspecting: false, copy: true, busy: false, error: "", ...handlers, ...over,
});
const chosen = (inspected: DataDirInspect, over: Partial<DataDirFormProps> = {}) =>
  render({ choice: { kind: "folder", path: "E:/Sync/Werkterm" }, feedback: describeInspect(inspected, { allowSame: true }), ...over });
const checkbox = (tree: ReactNode) => findAll(tree, e => e.type === "input" && e.props.type === "checkbox")[0];
beforeEach(() => vi.clearAllMocks());

describe("setup dialog", () => {
  it("explains what is stored, keeps passwords on the device and shows the default path", () => {
    const tree = render();
    const text = textOf(tree);
    expect(text).toContain("Sitzungen, Tunnel, Makros, Designs und Einstellungen");
    expect(text).toContain("Passwörter bleiben im Schlüsselbund dieses Geräts");
    expect(text).toContain(status.defaultPath);
    expect(labels(tree)).toEqual(expect.arrayContaining(["Standardordner verwenden", "Ordner wählen…"]));
  });
  it("cannot be confirmed before a folder was chosen and has exactly one primary button", () => {
    const tree = render();
    expect(submits(tree).map(e => textOf(e.props.children as ReactNode))).toEqual(["Übernehmen"]);
    expect(submits(tree)[0].props.disabled).toBe(true);
  });
  it("does not close on Esc", () => {
    const tree = render();
    const preventDefault = vi.fn();
    (findAll(tree, e => e.type === "dialog")[0].props.onCancel as (event: { preventDefault(): void }) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });
  it("wires the explicit choices to their handlers", () => {
    const tree = render();
    (button(tree, "Standardordner verwenden")!.props.onClick as () => void)();
    (button(tree, "Ordner wählen…")!.props.onClick as () => void)();
    expect(handlers.onDefault).toHaveBeenCalledTimes(1);
    expect(handlers.onPick).toHaveBeenCalledTimes(1);
  });
});

describe("folder feedback", () => {
  it("existing data: reports it, hides the copy option and allows confirming", () => {
    const tree = chosen(info({ hasData: true }));
    expect(textOf(tree)).toContain("Vorhandene Werkterm-Daten gefunden; sie werden verwendet.");
    expect(textOf(tree)).toContain("E:/Sync/Werkterm");
    expect(checkbox(tree)).toBeUndefined();
    expect(submits(tree)[0].props.disabled).toBe(false);
  });
  it("empty folder: offers copying, preselected", () => {
    const tree = chosen(info());
    expect(checkbox(tree).props.checked).toBe(true);
    expect(textOf(findAll(tree, e => e.type === "label")[0])).toBe("Bisherige Daten dorthin kopieren");
    expect(submits(tree)[0].props.disabled).toBe(false);
  });
  it("copy option reflects an unchecked state and reports changes", () => {
    const tree = chosen(info(), { copy: false });
    expect(checkbox(tree).props.checked).toBe(false);
    (checkbox(tree).props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    expect(handlers.onCopy).toHaveBeenCalledWith(true);
  });
  it("not writable: shows an error alert (danger color class, not accent), blocks confirming, hides copying", () => {
    const tree = chosen(info({ writable: false }));
    const alert = findAll(tree, e => e.props.role === "alert")[0];
    expect(textOf(alert)).toBe("Der Ordner ist nicht beschreibbar.");
    expect(alert.props.className).toBe("datadir-error");
    expect(submits(tree)[0].props.disabled).toBe(true);
    expect(checkbox(tree)).toBeUndefined();
  });
  it("blocks confirming while the folder is inspected and while applying", () => {
    expect(submits(render({ choice: { kind: "folder", path: "E:/x" }, inspecting: true }))[0].props.disabled).toBe(true);
    expect(submits(chosen(info(), { busy: true }))[0].props.disabled).toBe(true);
  });
  it("confirms through the primary button", () => {
    (submits(chosen(info({ hasData: true })))[0].props.onClick as () => void)();
    expect(handlers.onSubmit).toHaveBeenCalledTimes(1);
  });
  it("shows an apply error in an alert", () => {
    const tree = chosen(info(), { error: "Tunnel vor dem Wechsel stoppen" });
    expect(findAll(tree, e => e.props.role === "alert").map(e => textOf(e))).toEqual(["Tunnel vor dem Wechsel stoppen"]);
  });
});

describe("restart notice", () => {
  it("is shown when changing the folder and when a folder is chosen at startup, not for the default folder", () => {
    expect(restartNote("change", null)).toBe("Werkterm wird neu gestartet. Offene Verbindungen werden getrennt.");
    expect(restartNote("setup", { kind: "folder", path: "E:/x" })).toBe("Werkterm wird neu gestartet.");
    expect(restartNote("setup", { kind: "default", path: "C:/d" })).toBe("");
    expect(restartNote("setup", null)).toBe("");
    expect(textOf(chosen(info(), { mode: "change", status: { ...status, configured: true } }))).toContain("Offene Verbindungen werden getrennt.");
  });
});

describe("change dialog", () => {
  const configured: DataDirStatus = { ...status, configured: true, custom: true };
  it("closes on Esc and offers the default folder only when a custom one is active", () => {
    const tree = render({ mode: "change", status: configured });
    const preventDefault = vi.fn();
    (findAll(tree, e => e.type === "dialog")[0].props.onCancel as (event: { preventDefault(): void }) => void)({ preventDefault });
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(labels(tree)).toContain("Standardordner verwenden");
    expect(labels(render({ mode: "change", status: { ...configured, custom: false } }))).not.toContain("Standardordner verwenden");
    expect(textOf(tree)).toContain(configured.path);
  });
  it("keeps the dialog open while applying", () => {
    const preventDefault = vi.fn();
    (findAll(render({ mode: "change", status: configured, busy: true }), e => e.type === "dialog")[0].props.onCancel as (event: { preventDefault(): void }) => void)({ preventDefault });
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });
  it("has one primary button next to Abbrechen", () => {
    const tree = chosen(info(), { mode: "change", status: configured });
    expect(labels(tree)).toContain("Abbrechen");
    expect(submits(tree)).toHaveLength(1);
  });
});

describe("unreachable dialog", () => {
  const unreachable: DataDirStatus = { ...status, configured: true, custom: true, reachable: false };
  it("names the path and offers the three actions with a single primary button", () => {
    const tree = render({ mode: "unreachable", view: "unreachable", status: unreachable });
    expect(textOf(tree)).toContain("Datenordner nicht erreichbar");
    expect(textOf(tree)).toContain(unreachable.path);
    expect(labels(tree)).toEqual(["Standardordner verwenden", "Anderen Ordner wählen…", "Erneut versuchen"]);
    expect(submits(tree).map(e => textOf(e.props.children as ReactNode))).toEqual(["Erneut versuchen"]);
  });
  it("does not close on Esc and wires retry and the alternatives", () => {
    const tree = render({ mode: "unreachable", view: "unreachable", status: unreachable });
    const preventDefault = vi.fn();
    (findAll(tree, e => e.type === "dialog")[0].props.onCancel as (event: { preventDefault(): void }) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(handlers.onCancel).not.toHaveBeenCalled();
    (button(tree, "Erneut versuchen")!.props.onClick as () => void)();
    (button(tree, "Anderen Ordner wählen…")!.props.onClick as () => void)();
    (button(tree, "Standardordner verwenden")!.props.onClick as () => void)();
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
    expect(handlers.onPick).toHaveBeenCalledTimes(1);
    expect(handlers.onDefault).toHaveBeenCalledTimes(1);
  });
  it("shows a failed retry as an alert and can go back from the chooser", () => {
    const tree = render({ mode: "unreachable", view: "unreachable", status: unreachable, error: "Datenordner weiterhin nicht erreichbar." });
    expect(findAll(tree, e => e.props.role === "alert").map(e => textOf(e))).toEqual(["Datenordner weiterhin nicht erreichbar."]);
    const chooser = render({ mode: "unreachable", view: "choose", status: unreachable });
    (button(chooser, "Zurück")!.props.onClick as () => void)();
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
  });
});

describe("settings section", () => {
  const configured: DataDirStatus = { ...status, configured: true, custom: true };
  const props = { error: "", onChange: vi.fn(), onDefault: vi.fn() };
  it("shows the selectable current path and both actions for a custom folder", () => {
    const tree = DataDirSection({ ...props, status: configured });
    expect(textOf(findAll(tree, e => e.type === "code")[0])).toBe(configured.path);
    expect(labels(tree)).toEqual(["Ordner ändern…", "Standardordner verwenden"]);
    (button(tree, "Ordner ändern…")!.props.onClick as () => void)();
    expect(props.onChange).toHaveBeenCalledTimes(1);
  });
  it("offers only changing for the default folder", () => {
    expect(labels(DataDirSection({ ...props, status: { ...configured, custom: false } }))).toEqual(["Ordner ändern…"]);
  });
  it("shows loading, unreachable and error states", () => {
    expect(textOf(DataDirSection({ ...props, status: null }))).toContain("Datenordner wird geladen…");
    expect(textOf(DataDirSection({ ...props, status: { ...configured, reachable: false } }))).toContain("Der Ordner ist nicht erreichbar.");
    expect(findAll(DataDirSection({ ...props, status: null, error: "kaputt" }), e => e.props.role === "alert").map(e => textOf(e))).toEqual(["kaputt"]);
  });
});

describe("unreachable dialog hint (L5)", () => {
  it("warns under 'Standardordner verwenden' that older data may lie there", () => {
    const tree = render({ mode: "unreachable", view: "unreachable", status: { ...status, configured: true, reachable: false } });
    expect(unreachableDefaultHint()).toBe("Dort können ältere Daten liegen. Der gewählte Ordner bleibt unverändert.");
    const hint = findAll(tree, e => e.type === "small")[0];
    expect(textOf(hint)).toBe(unreachableDefaultHint());
  });
});

describe("setup notice after resetting the pointer file (L4)", () => {
  it("shows the notice in the chooser", () => {
    expect(textOf(render({ notice: resetPointerNotice }))).toContain("Die bisherige Zeigerdatei bleibt als Sicherung erhalten.");
    expect(textOf(render())).not.toContain("Zeigerdatei");
  });
});

describe("status error dialog (L4)", () => {
  const props = { message: "Zeigerdatei hat eine unbekannte Version", busy: false, error: "", onRetry: vi.fn(), onReset: vi.fn() };
  it("shows the message with exactly the two actions and one primary button", () => {
    const tree = DataDirErrorDialog(props);
    expect(textOf(findAll(tree, e => e.props.role === "alert")[0])).toBe(props.message);
    expect(labels(tree)).toEqual(["Zurücksetzen und Ordner neu wählen", "Erneut versuchen"]);
    expect(submits(tree).map(e => textOf(e.props.children as ReactNode))).toEqual(["Erneut versuchen"]);
    (button(tree, "Zurücksetzen und Ordner neu wählen")!.props.onClick as () => void)();
    (button(tree, "Erneut versuchen")!.props.onClick as () => void)();
    expect(props.onReset).toHaveBeenCalledTimes(1);
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });
  it("cannot be dismissed with Esc and shows a failed action", () => {
    const tree = DataDirErrorDialog({ ...props, error: "Zurücksetzen fehlgeschlagen" });
    const preventDefault = vi.fn();
    (findAll(tree, e => e.type === "dialog")[0].props.onCancel as (event: { preventDefault(): void }) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(findAll(tree, e => e.props.role === "alert").map(e => textOf(e))).toEqual([props.message, "Zurücksetzen fehlgeschlagen"]);
  });
});

describe("restart dialog after a failed restart (M4)", () => {
  it("offers only 'Neu starten', cannot be dismissed and shows the error", () => {
    const onRestart = vi.fn();
    const tree = RestartDialog({ busy: false, error: "Neustart nicht möglich", onRestart });
    expect(labels(tree)).toEqual(["Neu starten"]);
    expect(submits(tree)).toHaveLength(1);
    expect(findAll(tree, e => e.props.role === "alert").map(e => textOf(e))).toEqual(["Neustart nicht möglich"]);
    const preventDefault = vi.fn();
    (findAll(tree, e => e.type === "dialog")[0].props.onCancel as (event: { preventDefault(): void }) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    (button(tree, "Neu starten")!.props.onClick as () => void)();
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
  it("disables the button while retrying", () => {
    expect(button(RestartDialog({ busy: true, error: "", onRestart: vi.fn() }), "Neu starten")!.props.disabled).toBe(true);
  });
});

describe("wording", () => {
  it("avoids 'bitte' and exclamation marks in every state", () => {
    const unreachable: DataDirStatus = { ...status, configured: true, reachable: false };
    const trees = [render(), chosen(info()), chosen(info({ writable: false })), chosen(info({ hasData: true })), render({ mode: "unreachable", view: "unreachable", status: unreachable }), DataDirSection({ status, error: "", onChange: vi.fn(), onDefault: vi.fn() })];
    for (const tree of trees) { expect(textOf(tree)).not.toMatch(/bitte|!/i); }
  });
});
