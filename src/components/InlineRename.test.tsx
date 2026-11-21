import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
import { InlineRename } from "./InlineRename";

type Props = Record<string, unknown>;
type Handler = (event: unknown) => void;
function field(name = "notes.old.txt", file = true) {
  const onDone = vi.fn();
  const element = InlineRename({ name, file, label: "Neuer Name", onDone }) as ReactElement<Props>;
  const input = { value: name, dataset: {} as Record<string, string>, focus: vi.fn(), setSelectionRange: vi.fn() };
  const key = (key: string) => {
    const event = { key, currentTarget: input, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (element.props.onKeyDown as Handler)(event);
    return event;
  };
  const blur = () => (element.props.onBlur as Handler)({ currentTarget: input });
  return { element, input, onDone, key, blur };
}

it("prefills the name and selects it without the extension on mount", () => {
  const { element, input } = field();
  expect(element.props.defaultValue).toBe("notes.old.txt");
  expect(element.props["aria-label"]).toBe("Neuer Name");
  input.dataset.file = element.props["data-file"] as string;
  (element.props.ref as (node: unknown) => void)(input);
  expect(input.focus).toHaveBeenCalled();
  expect(input.setSelectionRange).toHaveBeenCalledWith(0, 9);
});

it("selects a folder name completely", () => {
  const { element, input } = field("site.d", false);
  expect(element.props["data-file"]).toBeUndefined();
  (element.props.ref as (node: unknown) => void)(input);
  expect(input.setSelectionRange).toHaveBeenCalledWith(0, 6);
});

it("applies with Enter once, even if the removed field reports a blur afterwards", () => {
  const { input, onDone, key, blur } = field();
  input.value = "notes.txt";
  const event = key("Enter");
  expect(event.preventDefault).toHaveBeenCalled();
  expect(onDone).toHaveBeenCalledWith("notes.txt");
  blur();
  expect(onDone).toHaveBeenCalledTimes(1);
});

it("cancels with Escape and ignores the following blur", () => {
  const { input, onDone, key, blur } = field();
  input.value = "changed";
  key("Escape");
  blur();
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(onDone).toHaveBeenCalledWith(null);
});

it("applies on blur", () => {
  const { input, onDone, blur } = field();
  input.value = "other.txt";
  blur();
  expect(onDone).toHaveBeenCalledWith("other.txt");
});

it("keeps keys and clicks away from the row (Enter opens, Delete deletes, arrows move)", () => {
  const { element, onDone, key } = field();
  for (const name of ["Delete", "ArrowDown", "ArrowUp", "F2", "a"]) {
    const event = key(name);
    expect(event.stopPropagation, name).toHaveBeenCalled();
    expect(event.preventDefault, name).not.toHaveBeenCalled();
  }
  expect(key("Enter").stopPropagation).toHaveBeenCalled();
  expect(onDone).toHaveBeenCalledTimes(1);
  for (const handler of ["onClick", "onDoubleClick", "onContextMenu"]) {
    const event = { stopPropagation: vi.fn() };
    (element.props[handler] as Handler)(event);
    expect(event.stopPropagation, handler).toHaveBeenCalled();
  }
});
