import { describe, expect, it } from "vitest";
import { Grid } from "./retroGrid";
import { LemmingeSim } from "./lemminge";

function seeded(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const full = "x".repeat(80);
/** 16 x 80 terminal, cells 9 x 20; the given rows are full of text. The ground lies below the last text row (at least row 4). */
function make(textRows: Record<number, string>, seed = 1): LemmingeSim {
  const lines = Array.from({ length: 16 }, (_, r) => textRows[r] ?? "");
  const last = Math.max(...Object.keys(textRows).map(Number));
  const sim = new LemmingeSim(new Grid(lines, 16, 80, 9, 20, 2), Math.max(4, last + 1), seeded(seed));
  sim.spawnT = 1e9;
  return sim;
}
function run(sim: LemmingeSim, seconds: number, until: () => boolean = () => false): void {
  for (let i = 0; i < seconds * 30 && !until(); i++) sim.update(1 / 30);
}

describe("Retro Lemminge", () => {
  it("gives every 3rd to 4th Tux an umbrella", () => {
    const sim = make({ 1: full });
    const marked: number[] = [];
    for (let i = 1; i <= 40; i++) if (sim.spawn({ umbrella: undefined }).umbrella) marked.push(i);
    expect(marked[0]).toBeGreaterThanOrEqual(3); expect(marked[0]).toBeLessThanOrEqual(4);
    for (let i = 1; i < marked.length; i++) { expect(marked[i] - marked[i - 1]).toBeGreaterThanOrEqual(3); expect(marked[i] - marked[i - 1]).toBeLessThanOrEqual(4); }
    expect(marked.length).toBeGreaterThanOrEqual(9);
  });
  it("lets normal Tuxes enter only where the first fall is at most three rows", () => {
    const sim = make({ 2: "x".repeat(41), 8: full });
    for (let i = 0; i < 30; i++) {
      const t = sim.spawn({ umbrella: false });
      expect(t.umbrella).toBe(false);
      expect(t.x).toBeLessThan(41 * 9);
    }
  });
  it("kills a Tux that falls more than three rows without an umbrella (squash, no leftovers)", () => {
    const sim = make({ 6: full });
    const t = sim.spawn({ x: 100, umbrella: false });
    run(sim, 4, () => sim.stats.died > 0);
    expect(sim.stats.died).toBe(1); expect(t.state).toBe("die");
    run(sim, 2);
    expect(sim.tuxes).toHaveLength(0);
  });
  it("lets an umbrella Tux float down the same height and walk on", () => {
    const sim = make({ 6: full });
    const t = sim.spawn({ x: 100, umbrella: true });
    let floated = false;
    run(sim, 8, () => { if (t.state === "float") floated = true; return t.state === "walk"; });
    expect(floated).toBe(true); expect(t.state).toBe("walk"); expect(t.row).toBe(6);
    expect(sim.stats.died).toBe(0);
  });
  it("survives a fall of exactly three rows without an umbrella", () => {
    const sim = make({ 3: full });
    const t = sim.spawn({ x: 100, umbrella: false });
    run(sim, 4, () => t.state === "walk");
    expect(t.state).toBe("walk"); expect(t.row).toBe(3); expect(sim.stats.died).toBe(0);
  });
  it("digs with the hands: three characters vanish, the text comes back on restore", () => {
    const sim = make({ 3: full });
    const t = sim.spawn({ x: 100, umbrella: false });
    run(sim, 4, () => t.state === "walk");
    expect(sim.begin(t, "dig")).toBe(true); expect(t.state).toBe("dig");
    run(sim, 2);
    expect(sim.grid.destroyed.size).toBe(3);
    expect(sim.stats.died).toBe(0);
    sim.grid.restore();
    expect(sim.grid.destroyed.size).toBe(0);
  });
  it("lets a stopper turn other Tuxes around", () => {
    const sim = make({ 3: full });
    const stopper = sim.spawn({ x: 300, umbrella: true }), walker = sim.spawn({ x: 300, umbrella: true });
    run(sim, 4, () => stopper.state === "walk" && walker.state === "walk");
    stopper.x = 300; walker.x = 270; walker.dir = 1; walker.t = 0; stopper.cool = 99; walker.cool = 99;
    expect(sim.begin(stopper, "stop")).toBe(true);
    for (let i = 0; i < 60 && walker.dir > 0; i++) sim.update(1 / 30);
    expect(walker.dir).toBe(-1);
  });
  it("saves a Tux at the door on the ground", () => {
    const sim = make({ 3: full });
    const t = sim.spawn({ x: 100, umbrella: false });
    run(sim, 4, () => t.state === "walk");
    t.state = "walk"; t.row = sim.groundRow; t.y = sim.grid.floorY(sim.groundRow); t.x = sim.doorX - 100; t.dir = 1; t.t = 0;
    run(sim, 15, () => sim.stats.saved > 0);
    expect(sim.stats.saved).toBe(1);
  });
});
