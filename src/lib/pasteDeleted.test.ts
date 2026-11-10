import { describe, expect, it } from "vitest";
import { pruneDeleted, type PasteChoice, type PasteRemember } from "./paste";

const choice: PasteChoice = { action: "paste", trim: true };
const remember: PasteRemember = { global: choice, sessions: { a: choice, b: choice, orphan: choice } };

describe("pruneDeleted", () => {
  it("removes only the deleted sessions and keeps orphaned entries of other devices", () => {
    expect(pruneDeleted(remember, ["a"])).toEqual({ global: choice, sessions: { b: choice, orphan: choice } });
  });
  it("returns the same object when nothing known was deleted", () => {
    expect(pruneDeleted(remember, ["zzz"])).toBe(remember);
    expect(pruneDeleted(remember, [])).toBe(remember);
  });
});
