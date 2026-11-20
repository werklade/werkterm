import { describe, expect, it } from "vitest";
import { Grid } from "./retroGrid";
import { GeruestSim, MAX_LADDERS, MIN_LADDER_GAP, ROBOT_MIN_Y } from "./geruest";

function seeded(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
function make(lines: string[], seed = 1): GeruestSim {
  const padded = Array.from({ length: 16 }, (_, r) => lines[r] ?? "");
  const sim = new GeruestSim(new Grid(padded, 16, 80, 9, 20, 0), seeded(seed));
  sim.spawnT = 1e9;
  return sim;
}
/** Rows 3 to 12 with text; the top row is short (robot) or reaches far to the right. */
function rows(robot: boolean): string[] {
  return Array.from({ length: 16 }, (_, r) => (r < 3 || r > 12 ? "" : r === 3 ? "y".repeat(robot ? 40 : 75) : "x".repeat(60)));
}
function run(sim: GeruestSim, seconds: number, until: () => boolean = () => false): void {
  for (let i = 0; i < seconds * 30 && !until(); i++) sim.update(1 / 30);
}

describe("Retro Gerüst girders and ladders", () => {
  it("makes a girder on every 2nd row from the lowest text row up, from the first to the last character", () => {
    const sim = make(["", "  abc", "", "x    y"]);
    expect(sim.girders.map(g => g.r)).toEqual([1, 3]);
    expect(sim.girders[0]).toMatchObject({ c1: 2, c2: 4, x1: 18, x2: 45 });
    expect(sim.girders[1]).toMatchObject({ c1: 0, c2: 5, x1: 0, x2: 54 });
    // Rows 3 to 12 with text: girders on 12, 10, 8, 6, 4; rows 3, 5, ... stay readable.
    expect(make(rows(false)).girders.map(g => g.r)).toEqual([4, 6, 8, 10, 12]);
    // Empty rows in the sequence are left out.
    expect(make(["", "", "xx", "", "", "", "xxxx", "", "xxxxxx"]).girders.map(g => g.r)).toEqual([2, 6, 8]);
  });
  it("drops girders above 48 pixels, so the top girder always has room for the robot", () => {
    const sim = make(Array.from({ length: 12 }, () => "x".repeat(60)));
    expect(sim.girders.map(g => g.r)).toEqual([3, 5, 7, 9, 11]);
    expect(sim.girders[0].y).toBeGreaterThanOrEqual(ROBOT_MIN_Y);
  });
  it("puts one to three ladders between each girder and the one above, spanning the rows in between, at least four apart", () => {
    const spaced = Array.from({ length: 16 }, (_, r) => (r > 2 && r < 13 ? (r % 2 ? "abc ".repeat(20) : "ab ".repeat(26)) : ""));
    for (let seed = 1; seed <= 30; seed++) {
      const sim = make(spaced, seed);
      for (let i = 1; i < sim.girders.length; i++) {
        const mine = sim.ladders.filter(l => l.lo === i);
        expect(mine.length).toBeGreaterThanOrEqual(1); expect(mine.length).toBeLessThanOrEqual(MAX_LADDERS);
        expect(sim.girders[i].r - sim.girders[i - 1].r).toBe(2);
        for (const l of mine) {
          expect(l.hi).toBe(i - 1);
          // Free in the girder row and in the readable row in between (columns 11, 23, 35 ...).
          for (let r = sim.girders[i - 1].r + 1; r <= sim.girders[i].r; r++) expect(sim.grid.hasText(r, l.c), `row ${r} col ${l.c}`).toBe(false);
          expect(l.c).toBeGreaterThanOrEqual(sim.girders[i].c1); expect(l.c).toBeLessThanOrEqual(sim.girders[i].c2);
        }
        for (const a of mine) for (const b of mine) if (a !== b) expect(Math.abs(a.c - b.c)).toBeGreaterThanOrEqual(MIN_LADDER_GAP);
      }
    }
  });
  it("falls back to any column of the overlap when a row has no space column", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const sim = make(rows(false), seed);
      for (let i = 1; i < sim.girders.length; i++) {
        const mine = sim.ladders.filter(l => l.lo === i);
        expect(mine.length).toBeGreaterThanOrEqual(1); expect(mine.length).toBeLessThanOrEqual(MAX_LADDERS);
      }
    }
  });
  it("joins rows that do not overlap at all by widening the lower girder", () => {
    const sim = make(["ab", "", " ".repeat(40) + "cdef"]);
    expect(sim.ladders).toHaveLength(1);
    const l = sim.ladders[0];
    expect(sim.girders[1].c1).toBeLessThanOrEqual(l.c); expect(sim.girders[0].c2).toBeGreaterThanOrEqual(l.c);
  });
});

describe("Retro Gerüst robot", () => {
  it("stands at the right end of the top girder at least 48 pixels down, also when the text fills the corner", () => {
    for (const lines of [rows(true), rows(false)]) {
      const sim = make(lines);
      expect(sim.goalG).toBe(0);
      const g = sim.girders[0];
      expect(sim.robot).not.toBeNull(); expect(sim.robot!.x).toBe(g.x2 - 54);
    }
  });
  it("appears also when the text starts in row 0, on the top girder kept (y at least 48), with the flag there", () => {
    const sim = make(Array.from({ length: 12 }, () => "x".repeat(60)));
    const g = sim.girders[sim.goalG];
    expect(sim.goalG).toBe(0); expect(g.r).toBe(3); expect(g.y).toBeGreaterThanOrEqual(ROBOT_MIN_Y);
    expect(sim.robot).not.toBeNull(); expect(sim.robot!.x).toBe(g.x2 - 54);
    expect(sim.flagX).toBeGreaterThanOrEqual(g.x1); expect(sim.flagX).toBeLessThan(g.x2);
    const t = sim.spawn();
    sim.sendToGoal(t);
    expect(t.g).toBe(sim.goalG); expect(t.y).toBe(g.y);
    let cheered = false;
    run(sim, 10, () => { if (t.state === "cheer") cheered = true; return sim.stats.goal > 0; });
    expect(cheered).toBe(true); expect(sim.stats.goal).toBe(1);
  });
  it("throws its barrels from the robot girder and ends cleanly when the Tuxes leave", () => {
    const sim = make(Array.from({ length: 12 }, () => "x".repeat(60)), 4);
    const robot = sim.robot!;
    robot.next = 0;
    run(sim, 2, () => sim.barrels.length > 0);
    expect(sim.barrels[0].g).toBe(sim.goalG);
    sim.spawn();
    run(sim, 2, () => robot.state === "idle");
    robot.next = 0; run(sim, 0.6, () => robot.state === "lift");
    expect(robot.state).toBe("lift");
    sim.beginLeave();
    run(sim, 60, () => sim.done);
    expect(sim.done).toBe(true); expect(sim.barrels).toHaveLength(0); expect(robot.state).toBe("idle");
  });
  it("has no robot and no barrels when no girder lies 48 pixels down (terminal too small)", () => {
    const sim = make(["xxxxxxxx", "", "xxxxxxxx"]);
    expect(sim.usable).toBe(true); expect(sim.robot).toBeNull(); expect(sim.goalG).toBe(0);
    run(sim, 40);
    expect(sim.barrels).toHaveLength(0);
  });
  it("crumbles characters only in the top three text rows", () => {
    const sim = make(rows(true), 3);
    const robot = sim.robot!;
    for (let i = 0; i < 30 * 90; i++) {
      if (robot.state === "idle" && robot.nextStomp > 0.2) robot.nextStomp = 0;
      sim.update(1 / 30);
    }
    expect(sim.grid.destroyed.size).toBeGreaterThan(0);
    for (const k of sim.grid.destroyed) expect(sim.topRows.has(Math.floor(k / 80))).toBe(true);
    expect([...sim.topRows]).toEqual([3, 4, 5]);
  });
  it("throws barrels that roll along the girders", () => {
    const sim = make(rows(true), 4);
    let seen = 0; const ids = new Set<number>();
    run(sim, 30, () => { for (const b of sim.barrels) if (!ids.has(b.id)) { ids.add(b.id); seen++; } return false; });
    expect(seen).toBeGreaterThanOrEqual(3);
  });
});

describe("Retro Gerüst Tuxes", () => {
  it("sends a Tux back to the start after a barrel hit (blink, puff, restart bottom left)", () => {
    const sim = make(rows(false));
    const bottom = sim.girders.length - 1, t = sim.spawn();
    t.state = "walk"; t.g = bottom; t.y = sim.girders[bottom].y; t.x = 100; t.dir = 1; t.t = 0; t.forced = true; t.noJump = true;
    sim.addBarrel(160, bottom, -1);
    run(sim, 3, () => t.state === "hit");
    expect(t.state).toBe("hit"); expect(sim.stats.hit).toBe(1);
    run(sim, 1.1);
    expect(t.state).toBe("wait");
    run(sim, 1, () => t.state === "beam");
    expect(t.state).toBe("beam"); expect(t.g).toBe(bottom); expect(t.x).toBeLessThan(40); expect(t.y).toBe(sim.girders[bottom].y);
  });
  it("is only hit on its own level: a falling barrel or one on another ladder passes", () => {
    const sim = make(rows(false));
    const bottom = sim.girders.length - 1, t = sim.spawn();
    t.state = "walk"; t.g = bottom; t.y = sim.girders[bottom].y; t.x = 200; t.dir = 1; t.forced = true; t.noJump = true;
    const falling = sim.addBarrel(200, bottom - 1, 1);
    falling.state = "fall"; falling.y = t.y - 14; falling.vy = 0; falling.fromG = bottom - 1;
    sim.update(1 / 60);
    expect(t.state).toBe("walk"); expect(sim.stats.hit).toBe(0);
    // A barrel rolling on the girder above the Tux does not touch it either.
    falling.dead = true;
    const above = sim.addBarrel(t.x + 4, bottom - 1, -1);
    sim.update(1 / 60);
    expect(t.state).toBe("walk"); expect(sim.stats.hit).toBe(0);
    above.dead = true;
    // Climbing: a barrel on another ladder passes, one on the same ladder hits.
    const [l1, l2] = [sim.ladders.find(l => l.lo === bottom)!, sim.ladders.find(l => l.lo === bottom - 1)!];
    t.state = "climb"; t.ladder = l1; t.cd = -1; t.x = l1.x; t.y = sim.girders[bottom].y - 10;
    const other = sim.addBarrel(l1.x, bottom - 1, 1);
    other.state = "ladder"; other.ladder = l2; other.y = t.y - 14;
    sim.update(1 / 60);
    expect(t.state).toBe("climb"); expect(sim.stats.hit).toBe(0);
    other.state = "ladder"; other.ladder = l1; other.x = l1.x; other.y = t.y - 14; other.dead = false;
    sim.update(1 / 60);
    expect(t.state).toBe("hit"); expect(sim.stats.hit).toBe(1);
  });
  it("hits a Tux with a barrel rolling on the same girder", () => {
    const sim = make(rows(false));
    const bottom = sim.girders.length - 1, t = sim.spawn();
    t.state = "walk"; t.g = bottom; t.y = sim.girders[bottom].y; t.x = 200; t.dir = 1; t.forced = true; t.noJump = true;
    sim.addBarrel(204, bottom, -1);
    sim.update(1 / 60);
    expect(t.state).toBe("hit");
  });
  it("jumps over rolling barrels", () => {
    let jumped = false;
    for (let seed = 1; seed <= 30 && !jumped; seed++) {
      const sim = make(rows(false), seed);
      const bottom = sim.girders.length - 1, t = sim.spawn();
      t.state = "walk"; t.g = bottom; t.y = sim.girders[bottom].y; t.x = 100; t.dir = 1; t.t = 0; t.forced = true;
      sim.addBarrel(220, bottom, -1);
      run(sim, 3, () => { if (t.state === "jump") jumped = true; return t.state === "hit"; });
    }
    expect(jumped).toBe(true);
  });
  it("climbs a ladder to the girder above", () => {
    const sim = make(rows(false), 2);
    const bottom = sim.girders.length - 1, ladder = sim.ladders.find(l => l.lo === bottom)!, t = sim.spawn();
    t.state = "walk"; t.g = bottom; t.y = sim.girders[bottom].y; t.x = ladder.x + (ladder.x > 60 ? -30 : 30); t.t = 0; t.forced = true;
    t.target = { x: ladder.x, flag: false, ladder, down: false };
    let climbed = false;
    run(sim, 8, () => { if (t.state === "climb") climbed = true; return t.g === ladder.hi; });
    expect(climbed).toBe(true); expect(t.g).toBe(ladder.hi); expect(t.y).toBe(sim.girders[ladder.hi].y);
  });
  it("reaches the goal flag on the robot girder, cheers and leaves counted as goal", () => {
    const sim = make(rows(false));
    const t = sim.spawn();
    sim.sendToGoal(t);
    expect(t.g).toBe(0);
    let cheered = false;
    run(sim, 10, () => { if (t.state === "cheer") cheered = true; return sim.stats.goal > 0; });
    expect(cheered).toBe(true); expect(sim.stats.goal).toBe(1);
  });
});

describe("Retro Gerüst exit on activity", () => {
  it("beams every Tux out within a second, removes the barrels and counts no goal", () => {
    const sim = make(rows(true), 2);
    for (let i = 0; i < 3; i++) { const t = sim.spawn(); t.state = "walk"; t.t = 0; }
    sim.robot!.next = 0;
    run(sim, 1.5);
    sim.exit();
    expect(sim.tuxes.every(t => t.state === "beamout")).toBe(true); expect(sim.barrels).toHaveLength(0);
    let time = 0;
    while (!sim.done && time < 2) { sim.update(1 / 60); time += 1 / 60; }
    expect(sim.done).toBe(true); expect(time).toBeLessThan(1); expect(sim.stats.goal).toBe(0);
  });
});
