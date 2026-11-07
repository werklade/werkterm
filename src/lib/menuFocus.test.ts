import { expect, it } from "vitest";
import { shouldFocusMenu, allowMenuMnemonic } from "./menu";
const event = { key: "Alt", code: "AltLeft", ctrlKey: false, altKey: true, shiftKey: false, metaKey: false };
it("reserves terminal/editor menu focus for F10", () => {
  expect(shouldFocusMenu(event, true)).toBe(false);
  expect(shouldFocusMenu({ ...event, key: "b" }, true)).toBe(false);
  expect(shouldFocusMenu(event, false)).toBe(true);
  expect(shouldFocusMenu({ ...event, key: "F10", altKey: false }, true)).toBe(true);
});
it("never treats AltGr as menu Alt", () => {
  for (const key of ["Alt", "@", "{", "[", "]", "}", "\\", "~", "|"]) {
    expect(shouldFocusMenu({ ...event, key, ctrlKey: true }, false)).toBe(false);
    expect(shouldFocusMenu({ ...event, key, getModifierState: () => true }, false)).toBe(false);
    expect(allowMenuMnemonic({ ...event, key, getModifierState: () => true }, false)).toBe(false);
  }
});
