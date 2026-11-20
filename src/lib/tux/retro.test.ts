import { describe, expect, it } from "vitest";
import { isRaster, editRows, sprites } from "./sprites";
import { retroDesignNames, retroIdForDesign, retroLooks, type RetroId } from "./retroSprites";
import { JumperScene, STAR_TIME } from "./jumper";
import { BurrowScene } from "./burrow";
import { BARRELS_PER_ACTION, ScaffoldScene } from "./scaffold";
import { actionsByDesign, type ActionId } from "./actions";
import type { Scene } from "./scene";

/** Deterministic random numbers. */
function seeded(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const layout = { width: 640, gy: 162 };
function run(scene: Scene, seconds: number, each?: () => void): number {
  let t = 0;
  while (!scene.done && t < seconds) { scene.step(1 / 30); t += 1 / 30; each?.(); }
  return t;
}

describe("sprite format", () => {
  it("keeps the existing Tux sprites on 16 x 16", () => {
    for (const rows of Object.values(sprites)) expect(isRaster(rows, 16, 16)).toBe(true);
  });
  it("edits rows and rejects edits outside the raster", () => {
    expect(editRows(["abcd", "efgh"], [[1, 1, "X Z"]])).toEqual(["abcd", "eXgZ"]);
    expect(() => editRows(["ab"], [[0, 1, "xy"]])).toThrow(RangeError);
  });
  it("gives every retro design 16 x 16 Tux frames and rectangular props with their own palette", () => {
    for (const look of Object.values(retroLooks)) {
      for (const [name, rows] of Object.entries({ ...look.tux, ...look.base })) expect(isRaster(rows, 16, 16), name).toBe(true);
      for (const [name, frames] of Object.entries(look.props)) for (const prop of frames) {
        expect(isRaster(prop.rows), name).toBe(true);
        for (const ch of prop.rows.join("")) if (ch !== ".") expect(prop.palette[ch], `${name}: colour ${ch}`).toBeDefined();
      }
      for (const rows of Object.values(look.tux)) for (const ch of rows.join("")) if (ch !== ".") expect(look.palette[ch], `Tux colour ${ch}`).toBeDefined();
    }
  });
  it("uses a fixed body colour per design and maps design names to ids", () => {
    expect(new Set(Object.values(retroLooks).map(look => look.palette.k)).size).toBe(3);
    for (const id of Object.keys(retroLooks) as RetroId[]) { expect(retroIdForDesign(retroDesignNames[id])).toBe(id); expect(retroLooks[id].palette["-"]).toBe(retroLooks[id].palette.k); }
    expect(retroIdForDesign("Werklade Dunkel")).toBeNull();
  });
  it("brings the props every action needs", () => {
    expect(retroLooks.lemminge.props.door).toHaveLength(3);
    expect(retroLooks.geruest.props.robot).toHaveLength(3);
    expect(retroLooks.geruest.props.barrel).toHaveLength(2);
    expect(retroLooks.huepfer.props.coin).toHaveLength(3);
    for (const name of ["block", "brick", "fish", "star", "feather"]) expect(retroLooks.huepfer.props[name].length).toBeGreaterThan(0);
  });
});

describe("Retro Lemminge actions", () => {
  it("finishes every action", () => {
    for (const action of actionsByDesign.lemminge) {
      const scene = new BurrowScene(action, layout, seeded(3));
      run(scene, 60);
      expect(scene.done, action).toBe(true);
    }
  });
  it("lets the stopper turn the walkers around", () => {
    const scene = new BurrowScene("stopper", layout, seeded(1));
    let turned = false;
    run(scene, 60, () => { if (scene.actors.some(a => a.mode === "stop") && scene.actors.some(a => a.dir < 0 && a.mode === "walk")) turned = true; });
    expect(turned).toBe(true);
  });
  it("opens a hole while digging and closes it about a second after the digger vanished", () => {
    const scene = new BurrowScene("digger", layout, seeded(2));
    let open = 0, closingFor = 0;
    run(scene, 60, () => {
      open = Math.max(open, ...scene.holes.map(h => h.open));
      if (scene.holes.some(h => h.closing)) closingFor += 1 / 30;
    });
    expect(open).toBe(1);
    expect(closingFor).toBeGreaterThan(.9); expect(closingFor).toBeLessThan(1.2);
    expect(scene.holes).toHaveLength(0);
  });
  it("lowers new tuxes by parachute from above the top edge", () => {
    const scene = new BurrowScene("parachute", layout, seeded(4));
    expect(scene.actors.every(a => a.mode === "chute" && a.y < 0)).toBe(true);
  });
  it("builds five steps, then lets them fade", () => {
    const scene = new BurrowScene("builder", layout, seeded(5));
    let most = 0; run(scene, 60, () => { most = Math.max(most, scene.steps.length); });
    expect(most).toBe(5); expect(scene.steps).toHaveLength(0);
  });
  it("shows the door only for the exit and removes it afterwards", () => {
    const scene = new BurrowScene("exit", layout, seeded(6));
    expect(scene.door).not.toBeNull(); run(scene, 60);
    expect(scene.door).toBeNull(); expect(scene.actors).toHaveLength(0);
  });
});

describe("Retro Gerüst actions", () => {
  it("throws the barrels, which roll along girders, and ends with the scaffold gone", () => {
    const scene = new ScaffoldScene("barrels", layout, seeded(7));
    let thrown = 0; const seen = new Set<object>();
    run(scene, 90, () => scene.barrels.forEach(b => { if (!seen.has(b)) { seen.add(b); thrown++; } }));
    expect(scene.done).toBe(true); expect(thrown).toBe(BARRELS_PER_ACTION);
    expect(scene.robot).toBeNull(); expect(scene.barrels).toHaveLength(0); expect(scene.scaffold).toBe(0);
  });
  it("lets barrels take ladders down", () => {
    let ladderRuns = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const scene = new ScaffoldScene("barrels", layout, seeded(seed));
      run(scene, 90, () => { if (scene.barrels.some(b => b.mode === "ladder")) { ladderRuns++; } });
    }
    expect(ladderRuns).toBeGreaterThan(0);
  });
  it("climbs the ladders up and down", () => {
    const scene = new ScaffoldScene("climb", layout, seeded(8));
    const modes = new Set<string>(); const levels = new Set<number>();
    run(scene, 90, () => scene.actors.forEach(a => { modes.add(a.mode); levels.add(a.gi); }));
    expect(modes.has("climb")).toBe(true); expect([...levels].sort()).toEqual([0, 1, 2]); expect(scene.done).toBe(true);
  });
  it("raises the flag when a tux reaches the top", () => {
    const scene = new ScaffoldScene("flag", layout, seeded(9));
    let flagged = false; run(scene, 90, () => { if (scene.flag && scene.actors[0]?.gi === 0) flagged = true; });
    expect(flagged).toBe(true); expect(scene.done).toBe(true);
  });
  it("jumps over rolling barrels", () => {
    let jumped = false;
    for (let seed = 1; seed <= 40 && !jumped; seed++) {
      const scene = new ScaffoldScene("barrels", layout, seeded(seed));
      run(scene, 90, () => { if (scene.actors.some(a => a.mode === "jump")) jumped = true; });
    }
    expect(jumped).toBe(true);
  });
});

describe("Retro Hüpfer actions", () => {
  const play = (action: ActionId, seed = 1) => { const scene = new JumperScene(action, layout, seeded(seed)); return { scene, seconds: run(scene, 60) }; };
  it("finishes every action", () => { for (const action of actionsByDesign.huepfer) expect(play(action).scene.done, action).toBe(true); });
  it("bumps the block from below and yields a coin", () => {
    const scene = new JumperScene("coin", layout, seeded(1));
    let coins = 0, bumped = false;
    run(scene, 60, () => { coins = Math.max(coins, scene.items.filter(i => i.kind === "coin").length); if (scene.blocks[1].bump < 1) bumped = true; });
    expect(bumped).toBe(true); expect(coins).toBe(1);
    expect(scene.blocks[1].left).toBe(0);
  });
  it("lets the tux eat the fish and briefly grow to 150 percent", () => {
    const scene = new JumperScene("fish", layout, seeded(1));
    let biggest = 1; run(scene, 60, () => scene.actors.forEach(a => { biggest = Math.max(biggest, a.scale); }));
    expect(biggest).toBe(1.5); expect(scene.actors).toHaveLength(0);
  });
  it("makes the star blink the body colour and speed the tux up for about 4.5 seconds", () => {
    const scene = new JumperScene("star", layout, seeded(1));
    const tints = new Set<string>(); let boosted = 0, maxBoost = 0;
    run(scene, 60, () => scene.actors.forEach(a => { if (a.tint) tints.add(a.tint); if (a.boost > 0) boosted += 1 / 30; maxBoost = Math.max(maxBoost, a.boost); }));
    expect(tints.size).toBeGreaterThan(1);
    expect(maxBoost).toBeGreaterThanOrEqual(STAR_TIME - .1); expect(maxBoost).toBeLessThanOrEqual(STAR_TIME);
    expect(boosted).toBeGreaterThan(2); expect(boosted).toBeLessThanOrEqual(STAR_TIME + .1);
  });
  it("runs 1.8 times as fast with the star", () => {
    const scene = new JumperScene("coin", layout, seeded(1));
    const actor = scene.actors[0]; actor.script = [{ t: "leave" }]; actor.x = 100;
    scene.step(.1); const normal = actor.x - 100;
    actor.x = 100; actor.boost = 3; scene.step(.1);
    expect((actor.x - 100) / normal).toBeCloseTo(1.8, 5);
  });
  it("catapults the tux up with the feather", () => {
    const scene = new JumperScene("feather", layout, seeded(1));
    let fastest = 0; run(scene, 60, () => scene.actors.forEach(a => { fastest = Math.min(fastest, a.vy); }));
    expect(fastest).toBeLessThan(-300);
  });
  it("pays out five coins from the multi block", () => {
    const scene = new JumperScene("coinSeries", layout, seeded(1));
    let spawned = 0; const seen = new Set<object>();
    run(scene, 60, () => scene.items.forEach(i => { if (!seen.has(i)) { seen.add(i); spawned++; } }));
    expect(spawned).toBe(5); expect(scene.blocks[3].left).toBe(0);
  });
  it("keeps the empty block brown and lets the tux walk on it", () => {
    const scene = new JumperScene("emptyBlock", layout, seeded(1));
    let item = false, onLedge = false;
    run(scene, 60, () => { if (scene.items.length) item = true; if (scene.actors.some(a => a.y === scene.ledgeTop && !a.air)) onLedge = true; });
    expect(item).toBe(false); expect(onLedge).toBe(true);
    expect(scene.blocks[1].left).toBe(0);
  });
});
