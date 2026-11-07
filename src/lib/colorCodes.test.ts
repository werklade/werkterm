import { describe, expect, it } from "vitest";
import { colorCodeMatches, EDITOR_BACKGROUND, luminance, mixColor, parseColor, textColor } from "./colorCodes";

describe("color codes", () => {
  it.each([ ["#eef3fb", "#000000"], ["#ffffff", "#000000"], ["#1769ff", "#ffffff"], ["#c9374a", "#ffffff"], ["#fff", "#000000"], ["#ffff", "#000000"] ])("chooses contrasting text for %s", (code, expected) => {
    const color = parseColor(code);
    expect(color).not.toBeNull();
    expect(textColor(color!)).toBe(expected);
  });
  it("keeps the exact luminance threshold white", () => {
    expect(luminance({ r: 140, g: 140, b: 140 })).toBe(140);
    expect(textColor({ r: 140, g: 140, b: 140 })).toBe("#ffffff");
    expect(textColor({ r: 141, g: 141, b: 141 })).toBe("#000000");
  });
  it("expands short hex and preserves alpha", () => {
    expect(parseColor("#f08")).toEqual({ r: 255, g: 0, b: 136, a: 1 });
    expect(parseColor("#f08a")).toEqual({ r: 255, g: 0, b: 136, a: 170 / 255 });
    expect(parseColor("#1769ff80")?.a).toBe(128 / 255);
  });
  it("mixes alpha on the actual editor background before contrast", () => {
    const mixed = mixColor(parseColor("rgba(255, 255, 255, 0.5)")!, parseColor(EDITOR_BACKGROUND)!);
    expect(mixed).toEqual({ r: 142.5, g: 142.5, b: 142.5, a: 1 });
    expect(textColor(mixed)).toBe("#000000");
    expect(mixColor(parseColor("#0000")!, parseColor(EDITOR_BACKGROUND)!)).toEqual({ r: 30, g: 30, b: 30, a: 1 });
    expect(textColor(mixColor(parseColor("rgba(250.2,250.2,250.2,.5)")!, parseColor(EDITOR_BACKGROUND)!))).toBe("#000000");
  });
  it("accepts comma and modern space syntax with percentage channels and alpha", () => {
    expect(parseColor("rgb(100% 0% 0% / 50%)")).toEqual({ r: 255, g: 0, b: 0, a: .5 });
    expect(parseColor("rgba(12, 34, 56, 25%)")).toEqual({ r: 12, g: 34, b: 56, a: .25 });
    expect(parseColor("rgb(1 2 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
  });
  it("ignores invalid syntax and clamps out-of-range CSS values", () => {
    for (const code of ["#ggg", "#12345", "rgb(a,b,c)", "rgb(1 2 3 4)", "rgba(1,2,3/0.5)", "rgb(1 2 3 / .5 / .5)"]) expect(parseColor(code)).toBeNull();
    expect(parseColor("rgba(300,-2,0,2)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });
  it("finds complete codes, never prefixes embedded in longer words or IDs", () => {
    const source = "#fff #ffff #112233 #11223344 rgb(1 2 3 / .5) id#fff #fffword #fff-ab #123456789 #ggg";
    expect(colorCodeMatches(source).map(match => source.slice(match.from, match.to))).toEqual(["#fff", "#ffff", "#112233", "#11223344", "rgb(1 2 3 / .5)"]);
  });
});
