import { describe, expect, it } from "vitest";
import { isRaster, editRows, sprites } from "./sprites";
import { retroDesignNames, retroIdForDesign, retroLooks, type RetroId } from "./retroSprites";
import { Grid, retroStage, stageNeeds, lastTextRow, type RetroInput } from "./retroGrid";
import { createRetroSim } from "./retroSim";
import { LemmingeSim } from "./lemminge";
import { GeruestSim } from "./geruest";
import { HuepferSim } from "./huepfer";

function seeded(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const input = (lines: string[], extra: Partial<RetroInput> = {}): RetroInput => ({ lines, rows: 16, cols: 80, cellWidth: 9, cellHeight: 20, pixel: 2, ...extra });

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
      for (const [name, rows] of Object.entries(look.tux)) expect(isRaster(rows, 16, 16), name).toBe(true);
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
  it("brings every frame and prop the three behaviours draw", () => {
    const need: Record<RetroId, { tux: string[]; props: string[] }> = {
      lemminge: { tux: ["stand", "sideA", "sideB", "stopA", "stopB", "hang", "buildA", "buildB", "digA", "digB", "squash", "plopp"], props: ["badge", "hatchClosed", "hatchOpen", "canopy", "step", "door"] },
      geruest: { tux: ["stand", "sideA", "sideB", "climbA", "climbB", "jumpG", "cheer", "hit"], props: ["robot", "barrel", "flag"] },
      huepfer: { tux: ["stand", "sideA", "sideB", "jump", "eatA", "eatB", "crouch", "slam", "fallA", "fallB", "soar"], props: ["block", "brick", "coin", "fish", "star", "feather"] },
    };
    for (const id of Object.keys(need) as RetroId[]) {
      for (const name of need[id].tux) expect(retroLooks[id].tux[name], `${id}.${name}`).toBeDefined();
      for (const name of need[id].props) expect(retroLooks[id].props[name]?.length, `${id}.${name}`).toBeGreaterThan(0);
    }
    expect(retroLooks.lemminge.props.door).toHaveLength(3);
    expect(retroLooks.geruest.props.robot).toHaveLength(4);
    for (const robot of retroLooks.geruest.props.robot) expect(isRaster(robot.rows, 24, 24)).toBe(true);
    expect(retroLooks.huepfer.props.coin).toHaveLength(3);
  });
});

describe("text grid", () => {
  it("bridges gaps of up to two spaces and treats wider gaps as holes", () => {
    const grid = new Grid(["ab  cd", "ab   cd", "  ab  "], 3, 8, 9, 20, 2);
    expect(grid.solid(0, 2)).toBe(true); expect(grid.solid(0, 3)).toBe(true); expect(grid.bridged(0, 2)).toBe(true);
    expect(grid.solid(1, 2)).toBe(false); expect(grid.solid(1, 3)).toBe(false); expect(grid.solid(1, 4)).toBe(false);
    expect(grid.solid(2, 0)).toBe(false); expect(grid.solid(2, 5)).toBe(false);
  });
  it("destroys cells as an overlay and restores them", () => {
    const grid = new Grid(["abc"], 2, 4, 9, 20, 0);
    expect(grid.destroy(0, 1)).toBe(true); expect(grid.destroy(0, 1)).toBe(false); expect(grid.destroy(1, 1)).toBe(false);
    expect(grid.hasChar(0, 1)).toBe(false); expect(grid.hasText(0, 1)).toBe(true); expect(grid.solid(0, 1)).toBe(false);
    grid.restore();
    expect(grid.hasChar(0, 1)).toBe(true); expect(grid.solid(0, 1)).toBe(true);
  });
  it("reads text ranges and rows", () => {
    const grid = new Grid(["", "  ab ", "", "x"], 4, 6, 9, 20, 0);
    expect(grid.range(1)).toEqual([2, 3]); expect(grid.range(0)).toBeNull(); expect(grid.textRows()).toEqual([1, 3]);
    expect(lastTextRow(["a", "", "b  ", "   "])).toBe(2);
  });
});

describe("stage", () => {
  it("puts the ground below the last text but not above the minimum height", () => {
    const stage = retroStage("lemminge", input(["$ ls", "x", ...Array(14).fill("")]))!;
    expect(stage.groundRow).toBe(Math.ceil(stageNeeds.lemminge.gy / 20));
    expect(retroStage("huepfer", input(Array(16).fill("text")))!.groundRow).toBe(15);
  });
  it("refuses terminals that are too small", () => {
    expect(retroStage("huepfer", input([], { rows: 5 }))).toBeNull();
    expect(retroStage("huepfer", input([], { cols: 30 }))).toBeNull();
    expect(retroStage("lemminge", input([], { cellHeight: 0 }))).toBeNull();
  });
  it("builds the simulation of the design, or nothing for Retro Gerüst with fewer than two text rows", () => {
    const lines = Array.from({ length: 16 }, (_, i) => (i > 2 && i < 9 ? "text ".repeat(12) : ""));
    expect(createRetroSim("lemminge", input(lines), seeded(1))!.sim).toBeInstanceOf(LemmingeSim);
    expect(createRetroSim("geruest", input(lines), seeded(1))!.sim).toBeInstanceOf(GeruestSim);
    expect(createRetroSim("huepfer", input(lines), seeded(1))!.sim).toBeInstanceOf(HuepferSim);
    expect(createRetroSim("geruest", input(["", "one row only"]), seeded(1))).toBeNull();
  });
  it("makes every design's Tuxes leave on their own after the idle limit", () => {
    const lines = Array.from({ length: 16 }, (_, i) => (i > 2 && i < 13 ? "text ".repeat(14) : ""));
    for (const id of ["lemminge", "geruest", "huepfer"] as RetroId[]) {
      const { sim } = createRetroSim(id, input(lines), seeded(5), 5)!;
      expect(sim.closing).toBe(false);
      for (let i = 0; i < 30 * 90 && !sim.done; i++) sim.update(1 / 30);
      expect(sim.closing, id).toBe(true); expect(sim.done, id).toBe(true);
    }
  });
});
