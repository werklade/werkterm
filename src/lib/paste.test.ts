import { describe, expect, it } from "vitest";
import { hasPasteControls, shouldConfirmPaste, singleLinePaste, stripLastNewline } from "./paste";
describe("paste", () => {
  it("confirms according to policy and size", () => {
    expect(shouldConfirmPaste("abc", "multiline")).toBe(false);
    expect(shouldConfirmPaste("a\nb", "multiline")).toBe(true);
    expect(shouldConfirmPaste("abc", "always")).toBe(true);
    expect(shouldConfirmPaste("a\nb", "never")).toBe(false);
    expect(shouldConfirmPaste("a".repeat(1024), "multiline")).toBe(false);
    expect(shouldConfirmPaste("a".repeat(1025), "multiline")).toBe(true);
    expect(shouldConfirmPaste("a".repeat(1025), "never")).toBe(false);
  });
  it("always warns about controls", () => {
    for (const c of ["\x1b", "\0", "\b", "\x7f"]) { expect(hasPasteControls(c)).toBe(true); expect(shouldConfirmPaste(c, "never")).toBe(true); }
    expect(hasPasteControls("ü\t\r\n")).toBe(false);
  });
  it("transforms line endings without losing other text", () => {
    expect(singleLinePaste("a\r\nb\rc\n")).toBe("a b c ");
    expect(stripLastNewline("a\r\n\r\n")).toBe("a\r\n");
    expect(stripLastNewline("a")).toBe("a");
  });
});
