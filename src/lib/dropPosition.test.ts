import { describe, expect, it } from "vitest";
import { dropToCss } from "./dropPosition";

describe("dropToCss", () => {
  it("divides physical pixels by devicePixelRatio outside Linux", () => {
    expect(dropToCss({ x: 200, y: 100 }, { linux: false, scaleFactor: 2, devicePixelRatio: 2 })).toEqual({ x: 100, y: 50 });
  });
  it("keeps logical Linux pixels at scale 2 without zoom (Ubuntu 26.04 measurement)", () => {
    expect(dropToCss({ x: 82, y: 442 }, { linux: true, scaleFactor: 2, devicePixelRatio: 2 })).toEqual({ x: 82, y: 442 });
  });
  it("removes only the webview zoom on Linux", () => {
    expect(dropToCss({ x: 150, y: 300 }, { linux: true, scaleFactor: 2, devicePixelRatio: 3 })).toEqual({ x: 100, y: 200 });
  });
  it("is the identity on Linux at scale 1 without zoom", () => {
    expect(dropToCss({ x: 12, y: 428 }, { linux: true, scaleFactor: 1, devicePixelRatio: 1 })).toEqual({ x: 12, y: 428 });
  });
  it("falls back to 1 for invalid factors", () => {
    expect(dropToCss({ x: 10, y: 20 }, { linux: true, scaleFactor: Number.NaN, devicePixelRatio: 0 })).toEqual({ x: 10, y: 20 });
    expect(dropToCss({ x: 10, y: 20 }, { linux: false, scaleFactor: 1, devicePixelRatio: Number.NaN })).toEqual({ x: 10, y: 20 });
  });
});
