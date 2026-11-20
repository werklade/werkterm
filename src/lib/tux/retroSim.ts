import { Grid, retroStage, type GridLevels, type RetroInput, type RetroStage, type Rng } from "./retroGrid";
import type { RetroId } from "./retroSprites";
import { LemmingeSim } from "./lemminge";
import { GeruestSim } from "./geruest";
import { HuepferSim } from "./huepfer";
export type RetroSim = LemmingeSim | GeruestSim | HuepferSim;
/** Gaps of up to this many spaces between two characters still count as floor (Retro Lemminge and Retro Hüpfer). */
export const BRIDGE = 2;
/**
 * Builds the simulation of a retro design for the current terminal text, or null if the terminal is too small
 * (or, for Retro Gerüst, has fewer than two text rows). Nothing runs in that case.
 */
export function createRetroSim(id: RetroId, input: RetroInput, rng: Rng, leaveAfter?: number): { sim: RetroSim; stage: RetroStage } | null {
  const stage = retroStage(id, input);
  if (!stage) return null;
  // Retro Lemminge and Retro Hüpfer: floors only on every 2nd row counted from the ground; Lemminge also know steel.
  const levels: GridLevels | null = id === "geruest" ? null : { bottom: stage.groundRow, steel: id === "lemminge" };
  const grid = new Grid(input.lines, input.rows, input.cols, stage.cw, stage.ch, id === "geruest" ? 0 : BRIDGE, levels);
  if (id === "lemminge") return { sim: new LemmingeSim(grid, stage.groundRow, rng, leaveAfter), stage };
  if (id === "huepfer") return { sim: new HuepferSim(grid, stage.groundRow, rng, leaveAfter), stage };
  const sim = new GeruestSim(grid, rng, leaveAfter);
  return sim.usable ? { sim, stage } : null;
}
