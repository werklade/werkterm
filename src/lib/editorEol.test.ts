import { describe, expect, it } from "vitest";
import { eolChanged, initialEol, mostFrequentEol } from "./editorEol";

describe("editor line ending state", () => {
  it.each(["lf", "crLf", "cr"] as const)("preserves detected %s", kind => expect(initialEol(kind)).toBe(kind));
  it("defaults an empty document to LF and requires a mixed target choice", () => {
    expect(initialEol("none")).toBe("lf");
    expect(initialEol("mixed")).toBeNull();
    expect(eolChanged("mixed", null)).toBe(false);
    expect(eolChanged("mixed", "lf")).toBe(true);
  });
  it("marks target changes dirty and reverting clean", () => {
    expect(eolChanged("crLf", "lf")).toBe(true);
    expect(eolChanged("crLf", "crLf")).toBe(false);
    expect(eolChanged("none", "lf")).toBe(false);
  });
  it("unifies to the most frequent kind and prefers LF for ties", () => {
    expect(mostFrequentEol({ lf: 2, crLf: 5, cr: 1 })).toBe("crLf");
    expect(mostFrequentEol({ lf: 1, crLf: 0, cr: 3 })).toBe("cr");
    expect(mostFrequentEol({ lf: 2, crLf: 2, cr: 2 })).toBe("lf");
    expect(mostFrequentEol({ lf: 0, crLf: 0, cr: 0 })).toBe("lf");
  });
});
