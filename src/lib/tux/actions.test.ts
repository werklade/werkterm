import { describe, expect, it } from "vitest";
import { ActionGate, actionsAllowed, actionsByDesign, areaFree, hitBlock, pickStage, planAction, robotArea, stageNeeds, lastTextRow, type Block, type StageInput } from "./actions";

const input = (lines: string[], extra: Partial<StageInput> = {}): StageInput => ({ lines, rows: 30, cols: 120, cellWidth: 9, cellHeight: 18, pixel: 2, ...extra });
describe("trigger rules", () => {
  it("allows at most one action per idle phase", () => {
    const gate = new ActionGate();
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false); expect(gate.available).toBe(false);
    gate.arm(); // activity: a new idle phase begins
    expect(gate.available).toBe(true); expect(gate.take()).toBe(true); expect(gate.take()).toBe(false);
  });
  it("needs an enabled Tux, a retro design and no reduced motion", () => {
    expect(actionsAllowed({ enabled: true, reducedMotion: false, design: "lemminge" })).toBe(true);
    expect(actionsAllowed({ enabled: false, reducedMotion: false, design: "lemminge" })).toBe(false);
    expect(actionsAllowed({ enabled: true, reducedMotion: true, design: "huepfer" })).toBe(false);
    expect(actionsAllowed({ enabled: true, reducedMotion: false, design: null })).toBe(false);
  });
});
describe("stage", () => {
  it("puts the ground on the line below the last text", () => {
    expect(lastTextRow(["a", "", "b  ", "   "])).toBe(2);
    const stage = pickStage("lemminge", input(["$ ls", "x", ...Array(10).fill("")]))!;
    expect(stage.groundRow).toBe(Math.ceil(stageNeeds.lemminge.gy * stage.scale / 18)); // minimum row wins over line 2
    const full = pickStage("lemminge", input(Array(30).fill("text")))!;
    expect(full.groundRow).toBe(29);
    expect(full.gy).toBe(29 * 18 / full.scale);
  });
  it("refuses terminals that are too small", () => {
    expect(pickStage("geruest", input([], { rows: 8 }))).toBeNull();
    expect(pickStage("huepfer", input([], { cols: 30 }))).toBeNull();
    expect(pickStage("lemminge", input([], { cellHeight: 0 }))).toBeNull();
    expect(planAction("geruest", input([], { rows: 8 }), () => 0)).toBeNull();
  });
});
describe("crane robot", () => {
  const stageInput = input([]);
  const stage = pickStage("geruest", stageInput)!;
  it("looks at the top right corner only", () => {
    const area = robotArea(stage, stageInput);
    expect(area.col1).toBe(120); expect(area.col0).toBeGreaterThan(90);
    const lines = Array<string>(30).fill("");
    expect(areaFree(lines, area)).toBe(true);
    lines[area.row0] = "x".repeat(area.col0 - 1);          // text left of the area
    expect(areaFree(lines, area)).toBe(true);
    lines[area.row1 - 1] = " ".repeat(area.col0) + "ab";   // text inside the area
    expect(areaFree(lines, area)).toBe(false);
  });
  it("is never planned while text sits in the corner, but plans the other actions", () => {
    const area = robotArea(stage, stageInput);
    const busy = Array<string>(30).fill("").map((_, row) => row === area.row0 ? " ".repeat(area.col0) + "output" : "");
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(planAction("geruest", input(busy), () => i / 40)!.action);
    expect(seen.has("barrels")).toBe(false); expect(seen.has("climb")).toBe(true); expect(seen.has("flag")).toBe(true);
    const free = new Set<string>();
    for (let i = 0; i < 40; i++) free.add(planAction("geruest", input([]), () => i / 40)!.action);
    expect(free.has("barrels")).toBe(true);
  });
  it("offers every action of a design when the screen is free", () => {
    for (const design of ["lemminge", "huepfer"] as const) {
      const seen = new Set<string>();
      for (let i = 0; i < 60; i++) seen.add(planAction(design, input([]), () => i / 60)!.action);
      expect([...seen].sort()).toEqual([...actionsByDesign[design]].sort());
    }
  });
});
describe("?-blocks", () => {
  const block = (left: number, brick = false): Block => ({ x: 0, brick, item: "fish", left, bump: 1 });
  it("yields its item once and stays empty afterwards", () => {
    const b = block(1);
    expect(hitBlock(b)).toBe("fish"); expect(b.left).toBe(0);
    expect(b.bump).toBe(0);
    b.bump = 1;
    expect(hitBlock(b)).toBeNull(); expect(b.bump).toBe(0); // an empty block only bumps
  });
  it("pays out a coin series one by one", () => {
    const b: Block = { x: 0, brick: false, item: "coin", left: 5, bump: 1 };
    const out = Array.from({ length: 7 }, () => hitBlock(b));
    expect(out).toEqual(["coin", "coin", "coin", "coin", "coin", null, null]);
  });
  it("bumps bricks without yielding anything", () => {
    const b = block(3, true);
    expect(hitBlock(b)).toBeNull(); expect(b.left).toBe(3); expect(b.bump).toBe(0);
  });
});
