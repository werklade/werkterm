import { expect, it } from "vitest";
import { createTux, IdleClock, platformsFromLines, stepTux } from "./simulation";
import { sprites } from "./sprites";
it("extracts contiguous non-space platforms and empty rows", () => {
  expect(platformsFromLines(["  abc d ", "   ", "x"])).toEqual([{ start: 2, end: 5, y: 0 }, { start: 6, end: 7, y: 0 }, { start: 0, end: 1, y: 2 }]);
});
it("lands, walks off an edge, falls and exits at the bottom", () => {
  const tux = createTux(1);
  const platforms = platformsFromLines(["abc"]);
  for (let i = 0; i < 30 && tux.state === "fall"; i++) stepTux(tux, .1, platforms, 6, () => 1);
  expect(tux.state).toBe("walk"); expect(tux.y).toBe(0);
  for (let i = 0; i < 20 && tux.state === "walk"; i++) stepTux(tux, .1, platforms, 6, () => 1);
  expect(tux.state).toBe("fall");
  for (let i = 0; i < 40; i++) stepTux(tux, .1, platforms, 6, () => 1);
  expect(tux.state).toBe("exit"); expect(tux.y).toBe(6);
});
it("digs through a platform without changing it", () => {
  const platforms = platformsFromLines(["abcdefghijk"]);
  const tux = createTux(1); Object.assign(tux, { state: "walk", y: 0, floor: 0, age: 3 });
  stepTux(tux, .1, platforms, 10, () => 0); expect(tux.state).toBe("dig");
  for (let i = 0; i < 10; i++) stepTux(tux, .1, platforms, 10);
  expect(tux.state).toBe("fall"); expect(tux.y).toBeGreaterThanOrEqual(1); expect(platforms[0].y).toBe(0);
});
it("digs into the line below and lands on its text", () => {
  const platforms = platformsFromLines(["abcdefghijk", "abcdefghijk"]);
  const tux = createTux(4); Object.assign(tux, { state: "dig", y: 0, floor: 0, age: .95 });
  stepTux(tux, .05, platforms, 10); expect(tux.state).toBe("fall");
  stepTux(tux, .05, platforms, 10); expect(tux.state).toBe("walk"); expect(tux.floor).toBe(1);
});
it("resets inactivity for input and output", () => {
  const clock = new IdleClock(0);
  expect(clock.remaining(60000, 60000)).toBe(0);
  clock.activity(60000); expect(clock.remaining(61000, 60000)).toBe(59000);
  clock.activity(61000); expect(clock.remaining(62000, 60000)).toBe(59000);
});
it("keeps every sprite on the same 16 by 16 raster", () => {
  for (const sprite of Object.values(sprites)) { expect(sprite).toHaveLength(16); for (const row of sprite) expect(row).toHaveLength(16); }
});
