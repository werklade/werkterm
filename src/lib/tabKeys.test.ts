import { describe, expect, it } from "vitest";
import { nextTabIndex } from "./tabKeys";

describe("nextTabIndex", () => {
  it("moves with ArrowDown/ArrowRight and wraps", () => {
    expect(nextTabIndex("ArrowDown", 0, 7)).toBe(1);
    expect(nextTabIndex("ArrowRight", 6, 7)).toBe(0);
  });
  it("moves with ArrowUp/ArrowLeft and wraps", () => {
    expect(nextTabIndex("ArrowUp", 3, 7)).toBe(2);
    expect(nextTabIndex("ArrowLeft", 0, 7)).toBe(6);
  });
  it("jumps with Home and End", () => {
    expect(nextTabIndex("Home", 4, 7)).toBe(0);
    expect(nextTabIndex("End", 2, 7)).toBe(6);
  });
  it("ignores other keys", () => {
    expect(nextTabIndex("Enter", 2, 7)).toBeNull();
  });
});
