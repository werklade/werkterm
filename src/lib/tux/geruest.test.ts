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
  it("makes one girder per text row, from the first to the last character", () => {
    const sim = make(["", "  abc", "", "x    y"]);
    expect(sim.girders.map(g => g.r)).toEqual([1, 3]);
    expect(sim.girders[0]).toMatchObject({ c1: 2, c2: 4, x1: 18, x2: 45 });
    expect(sim.girders[1]).toMatchObject({ c1: 0, c2: 5, x1: 0, x2: 54 });
  });
  it("puts one to three ladders between each row and the one above, on space columns, at least four apart", () => {
    const spaced = Array.from({ length: 16 }, (_, r) => (r > 2 && r < 13 ? "ab ".repeat(26) : ""));
    for (let seed = 1; seed <= 30; seed++) {
      const sim = make(spaced, seed);
      for (let i = 1; i < sim.girders.length; i++) {
        const mine = sim.ladders.filter(l => l.lo === i);
        expect(mine.length).toBeGreaterThanOrEqual(1); expect(mine.length).toBeLessThanOrEqual(MAX_LADDERS);
        for (const l of mine) {
          expect(l.hi).toBe(i - 1);
          expect(sim.grid.hasText(sim.girders[i].r, l.c)).toBe(false);
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
    const sim = make(["ab", "", "", " ".repeat(40) + "cdef"]);
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
  it("appears also when the text starts in row 0, on the first girder low enough, with the flag there", () => {
    const sim = make(Array.from({ length: 12 }, () => "x".repeat(60)));
    const g = sim.girders[sim.goalG];
    expect(g.r).toBe(2); expect(g.y).toBeGreaterThanOrEqual(ROBOT_MIN_Y); expect(sim.girders[sim.goalG - 1].y).toBeLessThan(ROBOT_MIN_Y);
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
    const sim = make(["xxxxxxxx", "xxxxxxxx"]);
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
