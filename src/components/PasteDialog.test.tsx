import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { PasteDialog } from "./PasteDialog";

// Same approach as passwordDialogs.test.tsx: only the React hook host is replaced, the JSX is real.
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useId: () => "test-paste",
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
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
const onAnswer = vi.fn();
const render = (props: { text?: string; multiExec?: boolean; hasProfile?: boolean }) =>
  PasteDialog({ text: props.text ?? "a\nb", count: 2, multiExec: props.multiExec ?? false, hasProfile: props.hasProfile ?? true, onAnswer });
const options = (tree: ReactNode) => findAll(tree, e => e.type === "option").map(e => ({ value: e.props.value as string, disabled: !!e.props.disabled }));
beforeEach(() => vi.clearAllMocks());

const keyEvent = (target: { hasAttribute(name: string): boolean }, currentTarget: unknown, init: Record<string, unknown> = {}) =>
  ({ key: "Enter", repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target, currentTarget, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...init });
const dialogOf = (tree: ReactNode) => findAll(tree, e => e.type === "dialog")[0];
const press = (tree: ReactNode, target: { hasAttribute(name: string): boolean } | "dialog", init?: Record<string, unknown>) => {
  const dialog = dialogOf(tree);
  const current = { hasAttribute: () => false };
  const event = keyEvent(target === "dialog" ? current : target, current, init);
  (dialog.props.onKeyDown as (e: unknown) => void)(event);
  return event;
};
const plain = { hasAttribute: () => false };

describe("PasteDialog keyboard", () => {
  it("marks the confirm button as initial focus for useModal", () => {
    const button = findAll(render({}), e => e.type === "button" && e.props.children === "Einfügen")[0];
    expect(button.props["data-autofocus"]).toBe(true);
  });
  it("Enter with focus on the dialog pastes and is consumed", () => {
    const event = press(render({}), "dialog");
    expect(onAnswer).toHaveBeenCalledWith("a\nb", null);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });
  it("Enter on the confirm button pastes exactly once", () => {
    press(render({}), { hasAttribute: (n: string) => n === "data-paste-confirm" });
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });
  it("Enter in the textarea or another control does not paste", () => {
    const event = press(render({}), plain);
    expect(onAnswer).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it("ignores key repeat and modified Enter", () => {
    press(render({}), "dialog", { repeat: true });
    press(render({}), "dialog", { ctrlKey: true });
    expect(onAnswer).not.toHaveBeenCalled();
  });
  it("Escape (dialog cancel event) answers null", () => {
    const preventDefault = vi.fn();
    (dialogOf(render({})).props.onCancel as (e: unknown) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(onAnswer).toHaveBeenCalledWith(null);
  });
});

describe("PasteDialog remember selection", () => {
  it("cancel answers null without a remember request", () => {
    const button = findAll(render({}), e => e.type === "button" && e.props.children === "Abbrechen")[0];
    (button.props.onClick as () => void)();
    expect(onAnswer).toHaveBeenCalledWith(null);
  });
  it("paste without selection sends no remember request", () => {
    const button = findAll(render({}), e => e.type === "button" && e.props.children === "Einfügen")[0];
    (button.props.onClick as () => void)();
    expect(onAnswer).toHaveBeenCalledWith("a\nb", null);
  });
  it("offers all four entries for a single terminal with profile", () => {
    expect(options(render({}))).toEqual([{ value: "none", disabled: false }, { value: "tab", disabled: false }, { value: "profile", disabled: false }, { value: "global", disabled: false }]);
  });
  it("disables the profile entry without saved session", () => {
    expect(options(render({ hasProfile: false })).find(o => o.value === "profile")?.disabled).toBe(true);
  });
  it("MultiExec allows only none and global", () => {
    expect(options(render({ multiExec: true, hasProfile: false }))).toEqual([{ value: "none", disabled: false }, { value: "tab", disabled: true }, { value: "profile", disabled: true }, { value: "global", disabled: false }]);
  });
  it("disables the selection and shows a hint for control characters", () => {
    const tree = render({ text: "a\x1b[31m" });
    expect(findAll(tree, e => e.type === "select")[0].props.disabled).toBe(true);
    expect(findAll(tree, e => e.type === "small").length).toBe(1);
    expect(findAll(render({}), e => e.type === "small").length).toBe(0);
  });
});
