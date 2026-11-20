import { describe, expect, it } from "vitest";
import { Grid } from "./retroGrid";
import { LemmingeSim, POP_GAP, POP_TIME, RISE, STEPS, type LemmingeTux } from "./lemminge";

function seeded(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const full = "x".repeat(80);
/**
 * 16 x 80 terminal, cells 9 x 20, ground in row 9 unless given: soil rows are 9, 7, 5, 3, 1 (every 2nd row from the
 * ground), the rows in between are text without floor.
 */
function make(textRows: Record<number, string>, seed = 1, ground = 9): LemmingeSim {
  const lines = Array.from({ length: 16 }, (_, r) => textRows[r] ?? "");
  const sim = new LemmingeSim(new Grid(lines, 16, 80, 9, 20, 2, { bottom: ground, steel: true }), ground, seeded(seed));
  sim.spawnT = 1e9;
  return sim;
}
function run(sim: LemmingeSim, seconds: number, until: () => boolean = () => false): void {
  for (let i = 0; i < seconds * 30 && !until(); i++) sim.update(1 / 30);
}
/** A Tux walking on soil row r at column c, without random abilities. */
function walker(sim: LemmingeSim, r: number, c: number, dir: 1 | -1 = 1, o: { climber?: boolean; umbrella?: boolean } = {}): LemmingeTux {
  const t = sim.spawn({ x: (c + 0.5) * 9, umbrella: o.umbrella ?? false, climber: o.climber ?? false });
  t.state = "walk"; t.row = r; t.y = sim.grid.floorY(r); t.dir = dir; t.t = 0; t.cool = 99; t.fresh = false;
  return t;
}
function dropFrom(sim: LemmingeSim, t: LemmingeTux, row: number): void {
  t.state = "fall"; t.row = -2; t.y = sim.grid.floorY(row); t.fallStart = t.y; t.vy = 0; t.t = 0; t.fresh = false;
}

describe("Retro Lemminge levels and steel", () => {
  it("has soil only on every 2nd row counted from the ground; the rows in between are text without floor", () => {
    const sim = make(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 1, full])));
    for (const r of [1, 3, 5, 7]) { expect(sim.grid.solid(r, 10), `row ${r}`).toBe(true); expect(sim.soilRow(r)).toBe(true); }
    for (const r of [2, 4, 6, 8]) { expect(sim.grid.solid(r, 10), `row ${r}`).toBe(false); expect(sim.soilRow(r)).toBe(false); }
    expect(sim.soilRow(9)).toBe(false);
  });
  it("turns digit words and paths on soil rows into steel, never words or text rows", () => {
    const line = "drwxr-xr-x  2 www-data  4096 09:12 1.2M /var/www/html name";
    const sim = make({ 3: line, 4: line });
    const at = (word: string) => line.indexOf(word);
    for (const w of ["4096", "09:12", "1.2M", "/var/www/html"]) for (let k = 0; k < w.length; k++) expect(sim.grid.isSteel(3, at(w) + k), w).toBe(true);
    expect(sim.grid.isSteel(3, at(" 2 ") + 1)).toBe(true);
    for (const w of ["drwxr-xr-x", "www-data", "name"]) expect(sim.grid.isSteel(3, at(w)), w).toBe(false);
    for (let c = 0; c < line.length; c++) expect(sim.grid.isSteel(4, c)).toBe(false);
  });
  it("shows soil only while Tuxes are active", () => {
    const sim = make({ 5: full });
    expect(sim.tiles).toBe(false);
    sim.spawn();
    expect(sim.tiles).toBe(true);
    sim.exit();
    run(sim, 2, () => sim.done);
    expect(sim.done).toBe(true); expect(sim.tiles).toBe(false);
  });
});

describe("Retro Lemminge abilities", () => {
  it("gives every 3rd to 4th Tux an umbrella and every 4th to 5th one the climber ability, never both", () => {
    const sim = make({ 1: full });
    const umbrellas: number[] = [], climbers: number[] = [];
    for (let i = 1; i <= 40; i++) {
      const t = sim.spawn();
      expect(t.umbrella && t.climber).toBe(false);
      if (t.umbrella) umbrellas.push(i);
      if (t.climber) climbers.push(i);
    }
    expect(umbrellas[0]).toBeGreaterThanOrEqual(3); expect(umbrellas[0]).toBeLessThanOrEqual(4);
    for (let i = 1; i < umbrellas.length; i++) { expect(umbrellas[i] - umbrellas[i - 1]).toBeGreaterThanOrEqual(3); expect(umbrellas[i] - umbrellas[i - 1]).toBeLessThanOrEqual(4); }
    expect(climbers[0]).toBeGreaterThanOrEqual(4); expect(climbers[0]).toBeLessThanOrEqual(6);
    expect(climbers.length).toBeGreaterThanOrEqual(6);
  });
  it("survives a fall of one level, dies after two levels without umbrella, floats down two with one", () => {
    const sim = make({ 5: full });
    const one = walker(sim, 5, 10); dropFrom(sim, one, 3);
    run(sim, 3, () => one.state !== "fall");
    expect(one.state).toBe("walk"); expect(one.row).toBe(5);
    const two = walker(sim, 5, 30); dropFrom(sim, two, 1);
    run(sim, 3, () => two.state !== "fall");
    expect(two.state).toBe("die"); expect(sim.stats.died).toBe(1);
    const chute = walker(sim, 5, 50, 1, { umbrella: true }); dropFrom(sim, chute, 1);
    let floated = false;
    run(sim, 8, () => { if (chute.state === "float") floated = true; return chute.state === "walk"; });
    expect(floated).toBe(true); expect(chute.row).toBe(5); expect(sim.stats.died).toBe(1);
  });
  it("does not count the first drop out of the hatch", () => {
    const sim = make({ 7: full });
    for (let i = 0; i < 10; i++) {
      const t = sim.spawn({ umbrella: false });
      expect(t.fresh).toBe(true);
      run(sim, 3, () => t.state === "walk" || t.state === "die");
      expect(t.state).toBe("walk"); expect(t.row).toBe(7);
      t.dead = true;
    }
    expect(sim.stats.died).toBe(0);
  });
  it("digs straight down: three clods go, the Tux falls one level and lives", () => {
    const sim = make({ 5: full, 7: full });
    const t = walker(sim, 5, 20);
    expect(sim.begin(t, "dig")).toBe(true); expect(t.state).toBe("dig");
    run(sim, 3, () => t.state === "walk" && t.row === 7);
    expect(sim.grid.destroyed.size).toBe(3);
    for (const k of sim.grid.destroyed) expect(Math.floor(k / 80)).toBe(5);
    expect(t.row).toBe(7); expect(sim.stats.died).toBe(0);
  });
  it("tunnels through a word and comes up at its end on the same row", () => {
    const sim = make({ 5: " ".repeat(10) + "abcdefgh" + " ".repeat(5) + "x".repeat(20) });
    const t = walker(sim, 5, 11, 1);
    expect(sim.begin(t, "tunnel")).toBe(true); expect(t.state).toBe("tunnel");
    run(sim, 8, () => t.state === "walk");
    expect(t.state).toBe("walk"); expect(t.row).toBe(5);
    const cols = [...sim.grid.destroyed].map(k => k % 80).sort((a, b) => a - b);
    expect(cols).toEqual([11, 12, 13, 14, 15, 16, 17]);
    for (const k of sim.grid.destroyed) expect(Math.floor(k / 80)).toBe(5);
  });
  it("digs diagonally: four clods in the walking direction, then one level down", () => {
    const sim = make({ 5: full, 7: full });
    const t = walker(sim, 5, 20, -1);
    expect(sim.begin(t, "diag")).toBe(true);
    run(sim, 4, () => t.state === "walk" && t.row === 7);
    expect([...sim.grid.destroyed].map(k => k % 80).sort((a, b) => a - b)).toEqual([17, 18, 19, 20]);
    expect(t.row).toBe(7); expect(sim.stats.died).toBe(0);
  });
  it("shrugs on steel, digs nothing and walks back the other way", () => {
    const line = "abcdef 4096 /usr/local/bin ghijkl";
    // Diagonal digging needs four clods in a row, so that Tux starts on the first digit.
    for (const [kind, word, off] of [["dig", "4096", 1], ["tunnel", "/usr/local/bin", 1], ["diag", "4096", 0]] as const) {
      const sim = make({ 5: line });
      const t = walker(sim, 5, line.indexOf(word) + off, 1);
      expect(sim.begin(t, kind), kind).toBe(true);
      expect(t.state).toBe("shrug");
      run(sim, 1);
      expect(t.state).toBe("walk"); expect(t.dir).toBe(-1); expect(sim.grid.destroyed.size).toBe(0);
    }
    const sim = make({ 5: line });
    expect(sim.stats.shrugs).toBe(0);
    expect(sim.begin(walker(sim, 5, 6), "dig")).toBe(false);
  });
  it("lets a climber climb a wall one level up and walk on; others do not", () => {
    const lines = { 5: " ".repeat(20) + "x".repeat(30), 7: "x".repeat(20) };
    const sim = make(lines, 3);
    const t = walker(sim, 7, 16, 1, { climber: true });
    let climbed = false;
    run(sim, 6, () => { if (t.state === "climb") climbed = true; return t.row === 5 && t.state === "walk"; });
    expect(climbed).toBe(true); expect(t.row).toBe(5); expect(t.y).toBe(sim.grid.floorY(5)); expect(sim.stats.climbed).toBe(1);
    for (let seed = 1; seed <= 5; seed++) {
      const other = make(lines, seed), u = walker(other, 7, 16, 1);
      run(other, 4, () => u.state === "climb");
      expect(u.state).not.toBe("climb"); expect(other.stats.climbed).toBe(0);
    }
  });
  it("builds five steps of eight pixels, exactly one level up", () => {
    const sim = make({ 7: full });
    const t = walker(sim, 7, 20);
    expect(sim.begin(t, "build")).toBe(true);
    run(sim, 4, () => t.state === "walk");
    expect(sim.steps).toHaveLength(STEPS);
    expect(sim.steps.map(s => sim.grid.floorY(7) - s.y)).toEqual([1, 2, 3, 4, 5].map(i => i * RISE));
    expect(t.y).toBe(sim.grid.floorY(5));
  });
  it("lets a stopper turn other Tuxes around", () => {
    const sim = make({ 5: full });
    const stopper = walker(sim, 5, 33), other = walker(sim, 5, 30);
    expect(sim.begin(stopper, "stop")).toBe(true);
    for (let i = 0; i < 60 && other.dir > 0; i++) sim.update(1 / 30);
    expect(other.dir).toBe(-1);
  });
  it("saves a Tux at the door on the ground", () => {
    const sim = make({ 5: full });
    const t = walker(sim, sim.groundRow, 20);
    t.x = sim.doorX - 100;
    run(sim, 15, () => sim.stats.saved > 0);
    expect(sim.stats.saved).toBe(1);
  });
});

describe("Retro Lemminge exit on activity", () => {
  it("pops every Tux from left to right within 0.8 seconds, also in mid-fall", () => {
    const sim = make({ 5: full, 7: full });
    const xs = [40, 10, 70, 25, 55, 60];
    const list = xs.map(c => walker(sim, 5, c));
    dropFrom(sim, list[2], 1);
    const popped: number[] = [];
    sim.exit();
    expect(sim.exiting).toBe(true);
    let time = 0;
    for (let i = 0; i < 60 && !sim.done; i++) {
      sim.update(1 / 60); time += 1 / 60;
      for (const t of list) if (t.state === "pop" && !popped.includes(t.id)) popped.push(t.id);
    }
    expect(sim.done).toBe(true); expect(time).toBeLessThan(0.8);
    expect(popped).toEqual(list.slice().sort((a, b) => a.x - b.x).map(t => t.id));
    expect(Math.min(POP_GAP, 0.5 / xs.length) * (xs.length - 1) + POP_TIME).toBeLessThanOrEqual(0.75);
    expect(sim.stats.died).toBe(0);
  });
});
