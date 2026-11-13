import { describe, expect, it } from "vitest";
import { formatSize } from "./formatSize";
import { setLanguage } from "../i18n";

describe("formatSize", () => {
  it.each([[0, "0,0 B"], [12, "12,0 B"], [1024, "1,0 KB"], [1536, "1,5 KB"], [1024 ** 2, "1,0 MB"], [1024 ** 3, "1,0 GB"], [5.25 * 1024 ** 3, "5,3 GB"]])("formats %s bytes with German decimals", (size, expected) => expect(formatSize(size)).toBe(expected));
  it("uses the decimal separator of the English interface", () => {
    setLanguage("en");
    try { expect(formatSize(1536)).toBe("1.5 KB"); } finally { setLanguage("de"); }
  });
  it("shows a dash for invalid sizes", () => {
    expect(formatSize(-1)).toBe("—");
    expect(formatSize(Number.NaN)).toBe("—");
  });
});
