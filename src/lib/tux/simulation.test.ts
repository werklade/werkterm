import { expect, it } from "vitest";
import { groundAhead, MAX_FALL, createTux, IdleClock, platformsFromLines, stepTux } from "./simulation";
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
  for (let i = 0; i < 16; i++) stepTux(tux, .1, platforms, 10);
  expect(tux.state).toBe("fall"); expect(tux.y).toBeGreaterThanOrEqual(1); expect(platforms[0].y).toBe(0);
});
it("digs into the line below and lands on its text", () => {
  const platforms = platformsFromLines(["abcdefghijk", "abcdefghijk"]);
  const tux = createTux(4); Object.assign(tux, { state: "dig", y: 0, floor: 0, age: 1.55 });
  stepTux(tux, .05, platforms, 10); expect(tux.state).toBe("fall");
  stepTux(tux, .05, platforms, 10); expect(tux.state).toBe("walk"); expect(tux.floor).toBe(1);
});
it("leaves a hole that later walkers fall through", () => {
  const platforms = platformsFromLines(["abcdefghijk"]);
  const holes: import("./simulation").Hole[] = [];
  const digger = createTux(4); Object.assign(digger, { state: "dig", y: 0, floor: 0, age: 1.55 });
  stepTux(digger, .05, platforms, 10, Math.random, holes);
  expect(holes).toEqual([{ row: 0, start: 1, end: 8 }]);
  expect(platforms).toHaveLength(1);
  const walker = createTux(2); Object.assign(walker, { state: "walk", y: 0, floor: 0, direction: 1 });
  for (let i = 0; i < 10 && walker.state === "walk"; i++) stepTux(walker, .1, platforms, 10, () => 1, holes);
  expect(walker.state).toBe("fall"); expect(walker.x).toBeLessThan(8);
});
it("waves at the edge, slips behind the corner and is gone", () => {
  const tux = createTux(5, 1); Object.assign(tux, { state: "exit", y: 6 });
  for (let i = 0; i < 20 && tux.leave < 0; i++) stepTux(tux, .1, [], 6, Math.random, [], 10);
  expect(tux.leave).toBe(0); expect(tux.x).toBe(7.5);
  for (let i = 0; i < 15; i++) stepTux(tux, .1, [], 6, Math.random, [], 10);
  expect(tux.x).toBe(7.5); expect(tux.state).toBe("exit");
  for (let i = 0; i < 12; i++) stepTux(tux, .1, [], 6, Math.random, [], 10);
  expect(tux.x).toBeGreaterThan(7.5); expect(tux.state).toBe("gone");
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
it("flaps to cap the fall speed", () => {
  const tux = createTux(1);
  for (let i = 0; i < 20; i++) stepTux(tux, .1, [], 100);
  expect(tux.vy).toBe(MAX_FALL);
});
it("slides on the belly across long stretches and stands up before the edge", () => {
  const platforms = platformsFromLines(["x".repeat(40)]);
  expect(groundAhead(platforms, [], 0, 5, 1)).toBe(34);
  const tux = createTux(2, 1); Object.assign(tux, { state: "walk", y: 0, floor: 0 });
  stepTux(tux, .05, platforms, 10, () => 1);
  expect(tux.sliding).toBe(true);
  for (let i = 0; i < 200 && tux.state === "walk" && tux.sliding; i++) stepTux(tux, .05, platforms, 10, () => 1);
  expect(tux.sliding).toBe(false); expect(tux.state).toBe("walk"); expect(tux.x).toBeGreaterThan(30);
});
