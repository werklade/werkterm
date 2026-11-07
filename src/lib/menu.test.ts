import { describe, expect, it } from "vitest";
import { menuMove, shortcutAction, shortcuts, type ShortcutEvent } from "./menu";
const event = (patch: Partial<ShortcutEvent>): ShortcutEvent => ({ key: "", code: "", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...patch });
describe("menu navigation", () => {
  it("wraps and skips disabled entries in either direction", () => {
    const disabled = [false, true, false];
    expect(menuMove(0, "ArrowDown", disabled)).toBe(2);
    expect(menuMove(2, "ArrowDown", disabled)).toBe(0);
    expect(menuMove(0, "ArrowUp", disabled)).toBe(2);
    expect(menuMove(0, "ArrowLeft", [false, false, false])).toBe(2);
    expect(menuMove(2, "ArrowRight", [false, false, false])).toBe(0);
    expect(menuMove(2, "Home", disabled)).toBe(0);
    expect(menuMove(0, "End", disabled)).toBe(2);
    expect(menuMove(0, "ArrowDown", [true, true])).toBe(-1);
    expect(menuMove(0, "ArrowDown", [])).toBe(-1);
  });
});
describe("shortcuts", () => {
  it("maps every registered shortcut exactly once", () => {
    const inputs: [Partial<ShortcutEvent>, string][] = [
      [{ key: "T", ctrlKey: true, shiftKey: true }, "local"], [{ key: "W", ctrlKey: true, shiftKey: true }, "close"],
      [{ key: "+", ctrlKey: true, shiftKey: true }, "larger"], [{ key: "_", ctrlKey: true, shiftKey: true }, "smaller"],
      [{ key: "=", code: "Digit0", ctrlKey: true, shiftKey: true }, "resetFont"], [{ key: "F11" }, "fullscreen"],
      [{ key: ",", ctrlKey: true }, "settings"],
    ];
    expect(new Set(shortcuts.map(s => s.shortcut)).size).toBe(shortcuts.length);
    expect(new Set(shortcuts.map(s => s.action)).size).toBe(shortcuts.length);
    for (const [input, action] of inputs) expect(shortcutAction(event(input), false)).toBe(action);
    expect(inputs.map(([input]) => shortcutAction(event(input), false)).sort()).toEqual(shortcuts.map(s => s.action).sort());
  });
  it("preserves terminal control sequences and excludes other modifiers", () => {
    for (const key of [",", "c", "v", "w", "t", "+", "-", "0"]) expect(shortcutAction(event({ key, ctrlKey: true }), true)).toBeNull();
    expect(shortcutAction(event({ key: "T", ctrlKey: true, shiftKey: true }), true)).toBe("local");
    expect(shortcutAction(event({ key: "T", ctrlKey: true, shiftKey: true, altKey: true }), false)).toBeNull();
    expect(shortcutAction(event({ key: "F11", shiftKey: true }), false)).toBeNull();
  });
});
