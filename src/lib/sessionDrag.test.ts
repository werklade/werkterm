import { describe, expect, it } from "vitest";
import { dragThreshold, dropTargetAt, passedThreshold, type DropElement } from "./sessionDrag";

/** Fake element: `attributes` per selector that `closest` would find. */
const element = (found: Record<string, string | null | undefined>): DropElement => ({
  closest: selector => selector in found ? { getAttribute: () => found[selector] ?? null } : null,
});

describe("session drag", () => {
  it("starts only after the movement threshold", () => {
    expect(dragThreshold).toBe(5);
    expect(passedThreshold({ x: 10, y: 10 }, 13, 13)).toBe(false);
    expect(passedThreshold({ x: 10, y: 10 }, 15, 10)).toBe(true);
    expect(passedThreshold({ x: 10, y: 10 }, 10, 4)).toBe(true);
  });
  it("finds the folder under the pointer, the top level in free space and nothing outside", () => {
    expect(dropTargetAt(element({ "[data-drop-folder]": "Lab/Linux", ".sessions-list": "" }))).toBe("Lab/Linux");
    expect(dropTargetAt(element({ "[data-drop-folder]": "", ".sessions-list": "" }))).toBe("");
    expect(dropTargetAt(element({ ".sessions-list": "" }))).toBe("");
    expect(dropTargetAt(element({}))).toBeNull();
    expect(dropTargetAt(null)).toBeNull();
  });
});
