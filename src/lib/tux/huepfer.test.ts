import { describe, expect, it } from "vitest";
import { Grid } from "./retroGrid";
import { HuepferSim, TURN_AFTER_FALL } from "./huepfer";

function seeded(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
/** Rows 1 to 9 hold words separated by single spaces (floor over the gaps), the ground lies in row 10. */
const words = Array.from({ length: 16 }, (_, r) => (r >= 1 && r <= 9 ? "abcd ".repeat(14) : ""));
function make(lines: string[] = words, seed = 1, ch = 20): HuepferSim {
  let last = -1;
  lines.forEach((l, r) => { if (l.trim()) last = r; });
  const sim = new HuepferSim(new Grid(lines, 16, 80, 9, ch, 2), Math.max(Math.ceil(134 / ch), last + 1), seeded(seed));
  sim.spawnT = 1e9;
  return sim;
}
function run(sim: HuepferSim, seconds: number, until: () => boolean = () => false): void {
  for (let i = 0; i < seconds * 30 && !until(); i++) sim.update(1 / 30);
}
/** A Tux standing on the text of a row. */
function stand(sim: HuepferSim, row: number, x: number, dir: 1 | -1 = 1) {
  const t = sim.spawn({ x });
  t.state = "walk"; t.row = row; t.y = sim.grid.floorY(row); t.baseY = t.y; t.x = x; t.dir = dir; t.t = 0;
  return t;
}

describe("Retro Hüpfer ?-blocks", () => {
  it("are never drawn over the top three text rows, nor stand over empty rows or the ground", () => {
    for (const ch of [18, 20]) {
      const sim = make(words, 1, ch);
      expect([...sim.topRows]).toEqual([1, 2, 3]);
      let placed = 0;
      for (let r = 0; r < 16; r++) {
        sim.blocks = [];
        const b = sim.placeBlock(r, "coin");
        // The drawn block: 16 pixels high, its lower edge at b.y.
        const top = Math.floor((sim.grid.floorY(r) - 60) / ch), bottom = Math.ceil((sim.grid.floorY(r) - 44) / ch) - 1;
        let free = top >= 0 && r >= 1 && r <= 9 && !sim.topRows.has(r);
        for (let k = top; k <= bottom; k++) if (sim.topRows.has(k)) free = false;
        expect(b === null, `ch ${ch} row ${r}`).toBe(!free);
        if (b) {
          placed++;
          expect(b.y - 16).toBeGreaterThanOrEqual(0);
          for (let k = Math.floor((b.y - 16) / ch); k <= Math.floor((b.y - 0.01) / ch); k++) expect(sim.topRows.has(k), `ch ${ch} row ${r} covers ${k}`).toBe(false);
        }
      }
      expect(placed).toBeGreaterThanOrEqual(2);
    }
  });
  it("hold at most four blocks at a time", () => {
    const sim = make();
    let placed = 0;
    for (let r = 4; r <= 9; r++) for (let i = 0; i < 3; i++) if (sim.placeBlock(r, "multi")) placed++;
    expect(placed).toBe(4); expect(sim.blocks).toHaveLength(4);
  });
  it("lets an item fall to the level of the Tux that hit the block, where the Tux collects it", () => {
    const sim = make();
    const t = stand(sim, 8, 100);
    const block = sim.placeBlock(8, "fish", t);
    expect(block).not.toBeNull();
    const level = sim.grid.floorY(8), rests = new Set<number>();
    run(sim, 25, () => {
      for (const it of sim.items) if (it.kind === "fish" && it.state === "rest") rests.add(it.y);
      return sim.stats.items > 0;
    });
    expect(rests.size).toBeGreaterThan(0);
    expect([...rests]).toEqual([level]);
    expect(sim.stats.items).toBe(1);
    expect(t.big).toBeGreaterThan(0);
  });
  it("lets the Tux walk on an empty block from above", () => {
    const lines = Array.from({ length: 16 }, (_, r) => (r >= 4 && r <= 12 ? "abcd ".repeat(14) : ""));
    const sim = make(lines, 1, 25);
    const block = sim.placeBlock(10, "empty")!;
    expect(block.state).toBe("empty");
    const t = sim.spawn({ x: block.x });
    t.state = "fall"; t.row = -2; t.x = block.x; t.y = block.y - 24; t.vy = 0;
    run(sim, 2, () => t.state === "walk");
    expect(t.state).toBe("walk"); expect(t.row).toBe(-1); expect(t.y).toBe(block.y - 16);
  });
});

describe("Retro Hüpfer zigzag", () => {
  it("changes direction with 70 percent after falling down into the next row", () => {
    const sim = make(words, 7);
    let turned = 0; const trials = 300;
    for (let i = 0; i < trials; i++) {
      sim.blocks = []; sim.tuxes = [];
      const t = sim.spawn({ x: 100 });
      t.state = "fall"; t.row = -2; t.x = 100; t.y = sim.grid.floorY(5) - 10; t.vy = 0; t.dir = 1;
      run(sim, 2, () => t.state === "walk");
      expect(t.row).toBe(5);
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
        const row = 2 + (i % 8), t = stand(sim, row, 60 + (i * 37) % 560, i % 2 ? 1 : -1), y0 = t.y;
        sim.startHop(t, i % 3 === 0);
        run(sim, 3, () => t.state !== "hop");
        expect(t.y, `ch ${ch} row ${row}`).toBeGreaterThanOrEqual(y0);
      }
    }
  });
  it("keeps its direction on a row until the end", () => {
    const sim = make(words, 3);
    const t = stand(sim, 5, 100, 1);
    run(sim, 0.9);
    expect(t.dir).toBe(1); expect(t.x).toBeGreaterThan(100); expect(t.row).toBe(5);
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
