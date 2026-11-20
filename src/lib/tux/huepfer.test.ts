import { describe, expect, it } from "vitest";
import { Grid } from "./retroGrid";
import { CROUCH_V, HuepferSim, LEAP_TIME, TURN_AFTER_FALL } from "./huepfer";

function seeded(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
/** Rows 1 to 9 hold words separated by single spaces, the ground lies in row 10: brick rows 2, 4, 6, 8, text rows in between. */
const words = Array.from({ length: 16 }, (_, r) => (r >= 1 && r <= 9 ? "abcd ".repeat(14) : ""));
function make(lines: string[] = words, seed = 1, ch = 20): HuepferSim {
  let last = -1;
  lines.forEach((l, r) => { if (l.trim()) last = r; });
  const ground = Math.max(Math.ceil(134 / ch), last + 1);
  const sim = new HuepferSim(new Grid(lines, 16, 80, 9, ch, 2, { bottom: ground }), ground, seeded(seed));
  sim.spawnT = 1e9;
  return sim;
}
function run(sim: HuepferSim, seconds: number, until: () => boolean = () => false): void {
  for (let i = 0; i < seconds * 30 && !until(); i++) sim.update(1 / 30);
}
/** A Tux standing on the bricks of a row. */
function stand(sim: HuepferSim, row: number, x: number, dir: 1 | -1 = 1) {
  const t = sim.spawn({ x });
  t.state = "walk"; t.row = row; t.y = sim.grid.floorY(row); t.baseY = t.y; t.x = x; t.dir = dir; t.t = 0;
  return t;
}

describe("Retro Hüpfer brick rows", () => {
  it("has bricks on every 2nd row counted from the ground; the rows in between are text without floor", () => {
    const sim = make();
    expect(sim.groundRow).toBe(10);
    for (const r of [2, 4, 6, 8]) { expect(sim.brickRow(r)).toBe(true); expect(sim.grid.solid(r, 1)).toBe(true); expect(sim.grid.solid(r, 4)).toBe(true); }
    for (const r of [1, 3, 5, 7, 9]) { expect(sim.brickRow(r)).toBe(false); expect(sim.grid.solid(r, 1)).toBe(false); }
    // Bricks only where characters are: the bridged gap is floor but no brick.
    expect(sim.grid.hasText(4, 4)).toBe(false); expect(sim.grid.bridged(4, 4)).toBe(true);
  });
  it("lets a falling Tux pass the text rows and land on the next brick row", () => {
    const sim = make();
    const t = sim.spawn({ x: 100 });
    t.state = "fall"; t.row = -2; t.y = sim.grid.floorY(4) + 2; t.vy = 0;
    run(sim, 2, () => t.state === "walk");
    expect(t.row).toBe(6);
  });
  it("shows bricks only while Tuxes are active", () => {
    const sim = make();
    expect(sim.tiles).toBe(false);
    stand(sim, 6, 100);
    expect(sim.tiles).toBe(true);
    sim.exit();
    run(sim, 2, () => sim.done);
    expect(sim.tiles).toBe(false);
  });
  it("stomps through its brick row one level down with the lower crouched jump (cell height 18 and 20)", () => {
    for (const ch of [18, 20]) {
      const sim = make(words, 2, ch);
      expect(sim.crouchV()).toBeLessThanOrEqual(CROUCH_V);
      expect(sim.crouchV() ** 2 / (2 * 900)).toBeLessThan(2 * ch);
      const t = stand(sim, 4, 100);
      expect(sim.startDuck(t)).toBe(true);
      let top = t.y;
      run(sim, 3, () => { top = Math.min(top, t.y); return t.state === "walk"; });
      expect(t.row, `ch ${ch}`).toBe(6);
      expect(top).toBeGreaterThan(sim.grid.floorY(2));
      expect(sim.grid.destroyed.size).toBeGreaterThan(0);
      for (const k of sim.grid.destroyed) expect(Math.floor(k / 80)).toBe(4);
    }
  });
});

describe("Retro Hüpfer ?-blocks", () => {
  it("sit in a gap of the brick row above the Tux, never within the top three text rows", () => {
    for (const ch of [18, 20]) {
      const sim = make(words, 1, ch);
      expect([...sim.topRows]).toEqual([1, 2, 3]);
      const rowsWithBlock: number[] = [];
      for (let r = 0; r < 16; r++) {
        sim.blocks = [];
        const b = sim.placeBlock(r, "coin");
        expect(b === null, `ch ${ch} row ${r}`).toBe(!sim.blockRowOk(r - 2));
        if (!b) continue;
        rowsWithBlock.push(r);
        expect(b.row).toBe(r - 2); expect(b.tr).toBe(r);
        expect(sim.brickRow(b.row)).toBe(true); expect(sim.topRows.has(b.row)).toBe(false);
        expect(sim.grid.bridged(b.row, sim.grid.colOf(b.x))).toBe(true);
        // Drawn 16 pixels high inside its own row.
        expect(b.y).toBe((b.row + 1) * ch); expect(Math.floor((b.y - 16) / ch)).toBe(b.row);
      }
      expect(rowsWithBlock).toEqual([6, 8, 10]);
    }
  });
  it("hold at most four blocks at a time", () => {
    const sim = make();
    let placed = 0;
    for (let r = 4; r <= 12; r++) for (let i = 0; i < 3; i++) if (sim.placeBlock(r, "multi")) placed++;
    expect(placed).toBe(4); expect(sim.blocks).toHaveLength(4);
  });
  it("gives a coin when the Tux jumps against the block from below", () => {
    const sim = make();
    const t = stand(sim, 8, 100);
    const block = sim.placeBlock(8, "coin", t)!;
    run(sim, 6, () => sim.stats.coins > 0);
    expect(sim.stats.coins).toBe(1); expect(block.state).toBe("empty"); expect(t.row).toBe(8);
  });
  it("lets an item come out below and fall to the level of the Tux, where the Tux collects it", () => {
    const sim = make();
    const t = stand(sim, 8, 100);
    const block = sim.placeBlock(8, "fish", t);
    expect(block).not.toBeNull();
    const level = sim.grid.floorY(8), rests = new Set<number>();
    let emergedBelow = true;
    run(sim, 25, () => {
      for (const it of sim.items) {
        if (it.kind === "fish" && it.state === "rest") rests.add(it.y);
        if (it.kind === "fish" && it.state === "emerge" && it.y < block!.y) emergedBelow = false;
      }
      return sim.stats.items > 0;
    });
    expect(emergedBelow).toBe(true);
    expect([...rests]).toEqual([level]);
    expect(sim.stats.items).toBe(1);
    expect(t.big).toBeGreaterThan(0);
  });
});

describe("Retro Hüpfer zigzag", () => {
  it("changes direction with 70 percent after falling down into the next row", () => {
    const sim = make(words, 7);
    let turned = 0; const trials = 300;
    for (let i = 0; i < trials; i++) {
      sim.blocks = []; sim.tuxes = [];
      const t = sim.spawn({ x: 100 });
      t.state = "fall"; t.row = -2; t.x = 100; t.y = sim.grid.floorY(6) - 10; t.vy = 0; t.dir = 1;
      run(sim, 2, () => t.state === "walk");
      expect(t.row).toBe(6);
      const after: number = t.dir;
      if (after === -1) turned++;
    }
    expect(TURN_AFTER_FALL).toBe(0.7);
    expect(turned / trials).toBeGreaterThan(0.6); expect(turned / trials).toBeLessThan(0.8);
  });
  it("never lands on a higher row after a random hop (cell height 18 and 20)", () => {
    for (const ch of [18, 20]) {
      const sim = make(words, 5, ch);
      for (let i = 0; i < 200; i++) {
        sim.blocks = []; sim.tuxes = [];
        const row = [2, 4, 6, 8][i % 4], t = stand(sim, row, 60 + (i * 37) % 560, i % 2 ? 1 : -1), y0 = t.y;
        sim.startHop(t, i % 3 === 0);
        run(sim, 3, () => t.state !== "hop");
        expect(t.y, `ch ${ch} row ${row}`).toBeGreaterThanOrEqual(y0);
      }
    }
  });
  it("keeps its direction on a row until the end", () => {
    const sim = make(words, 3);
    const t = stand(sim, 6, 100, 1);
    run(sim, 0.9);
    expect(t.dir).toBe(1); expect(t.x).toBeGreaterThan(100); expect(t.row).toBe(6);
  });
});

describe("Retro Hüpfer goal", () => {
  it("walks left along the lowest row to the flag, cheers there and leaves through the pipe", () => {
    const sim = make();
    const t = stand(sim, sim.groundRow, 400, -1);
    let cheered = false, raised = 0;
    run(sim, 40, () => { if (t.state === "cheer") cheered = true; raised = Math.max(raised, sim.flagLv); return sim.stats.saved > 0; });
    expect(cheered).toBe(true); expect(raised).toBeGreaterThan(0.5);
    expect(sim.stats.goal).toBe(1); expect(sim.stats.saved).toBe(1);
  });
});

describe("Retro Hüpfer exit on activity", () => {
  it("lets every Tux jump away with a coin sparkle in under a second", () => {
    const sim = make();
    const list = [stand(sim, 4, 100), stand(sim, 6, 300, -1), stand(sim, 8, 500)];
    sim.exit();
    expect(list.every(t => t.state === "leap")).toBe(true);
    expect(sim.items.filter(it => it.kind === "coin")).toHaveLength(3);
    const y0 = list.map(t => t.y);
    sim.update(0.1);
    list.forEach((t, i) => expect(t.y).toBeLessThan(y0[i]));
    let time = 0.1;
    while (!sim.done && time < 2) { sim.update(1 / 60); time += 1 / 60; }
    expect(sim.done).toBe(true); expect(time).toBeLessThan(1); expect(time).toBeGreaterThanOrEqual(LEAP_TIME);
  });
});
