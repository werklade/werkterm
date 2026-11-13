import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { UpdateTransfersDialog } from "./UpdateTransfersDialog";
import { RestartDialog } from "./DataDirForm";

vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), useId: () => "test-id" }));
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
const button = (tree: ReactNode, label: string) => findAll(tree, e => e.type === "button").find(e => textOf(e.props.children as ReactNode) === label);
beforeEach(() => vi.clearAllMocks());

describe("transfer question before an update", () => {
  it("names the number of transfers and answers per button; Esc declines", () => {
    const onAnswer = vi.fn();
    const tree = UpdateTransfersDialog({ count: 2, onAnswer });
    expect(textOf(tree)).toContain("2 Übertragungen laufen und werden abgebrochen.");
    (button(tree, "Installieren")!.props.onClick as () => void)();
    expect(onAnswer).toHaveBeenLastCalledWith(true);
    (button(tree, "Abbrechen")!.props.onClick as () => void)();
    expect(onAnswer).toHaveBeenLastCalledWith(false);
    const preventDefault = vi.fn();
    (findAll(tree, e => e.type === "dialog")[0].props.onCancel as (event: { preventDefault(): void }) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(onAnswer).toHaveBeenLastCalledWith(false);
  });
  it("has one primary button and the safe choice focused", () => {
    const tree = UpdateTransfersDialog({ count: 1, onAnswer: vi.fn() });
    expect(findAll(tree, e => e.type === "button" && e.props.type === "submit")).toHaveLength(1);
    expect(button(tree, "Abbrechen")!.props.autoFocus).toBe(true);
    expect(textOf(tree)).not.toMatch(/bitte|!/i);
  });
});

describe("restart dialog after a failed update", () => {
  it("says the update was not installed when the installer did not start", () => {
    const tree = RestartDialog({ busy: false, error: "", onRestart: vi.fn(), update: true, notInstalled: true });
    expect(textOf(tree)).toContain("Das Update wurde nicht installiert. Werkterm muss neu gestartet werden.");
    expect(findAll(tree, e => e.type === "button").map(e => textOf(e.props.children as ReactNode))).toEqual(["Neu starten"]);
  });
});
