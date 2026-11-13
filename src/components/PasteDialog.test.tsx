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
