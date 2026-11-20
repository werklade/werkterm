import type { RetroId } from "./retroSprites";
// Pure rules for the Tux actions of the retro designs: when one may start, where it plays, which one runs.
export type Rng = () => number;
export type ActionId =
  | "stopper" | "digger" | "parachute" | "builder" | "exit"      // Retro Lemminge
  | "barrels" | "climb" | "flag"                                  // Retro Gerüst
  | "coin" | "fish" | "star" | "feather" | "coinSeries" | "emptyBlock"; // Retro Hüpfer
export const actionsByDesign: Record<RetroId, ActionId[]> = {
  lemminge: ["stopper", "digger", "parachute", "builder", "exit"],
  geruest: ["barrels", "climb", "flag"],
  huepfer: ["coin", "fish", "star", "feather", "coinSeries", "emptyBlock"],
};

/** At most one action per idle phase: armed by activity (a new phase begins), consumed by the first action. */
export class ActionGate {
  private used = false;
  /** Call on every user activity: a new idle phase begins. */
  arm(): void { this.used = false; }
  /** True exactly once per phase. */
  take(): boolean { if (this.used) return false; this.used = true; return true; }
  get available(): boolean { return !this.used; }
}
/** Actions need an enabled Tux, a retro design and no request for reduced motion. */
export function actionsAllowed(options: { enabled: boolean; reducedMotion: boolean; design: RetroId | null }): boolean {
  return options.enabled && !options.reducedMotion && options.design !== null;
}
/** Seconds after the Tux run starts at which the action may begin (the Tuxes have landed by then). */
export function actionDelay(rng: Rng): number { return 5 + rng() * 9; }

/** Virtual pixels: one sprite pixel is 2 virtual pixels, so the scenes keep the proportions of the approved preview. */
export interface Stage { scale: number; width: number; gy: number; groundRow: number }
export interface StageInput { lines: string[]; rows: number; cols: number; cellWidth: number; cellHeight: number; pixel: number }
/** Minimum stage size in virtual pixels per design (ground distance from the top, width). */
export const stageNeeds: Record<RetroId, { gy: number; width: number }> = {
  lemminge: { gy: 70, width: 380 },
  geruest: { gy: 164, width: 460 },
  huepfer: { gy: 134, width: 440 },
};
export function lastTextRow(lines: string[]): number {
  for (let row = lines.length - 1; row >= 0; row--) if (lines[row].trim() !== "") return row;
  return -1;
}
/** The ground lies on the line below the last text; null if the terminal is too small for the design. */
export function pickStage(design: RetroId, input: StageInput): Stage | null {
  const { rows, cols, cellWidth, cellHeight, pixel } = input;
  if (!(rows > 0 && cols > 0 && cellWidth > 0 && cellHeight > 0 && pixel > 0)) return null;
  const scale = pixel / 2, needs = stageNeeds[design], width = cols * cellWidth / scale;
  if (width < needs.width) return null;
  const minRow = Math.ceil(needs.gy * scale / cellHeight);
  const groundRow = Math.min(rows - 1, Math.max(minRow, lastTextRow(input.lines) + 1));
  if (groundRow < minRow) return null;
  return { scale, width, gy: groundRow * cellHeight / scale, groundRow };
}
/** Cell rectangle (end exclusive) of the area top right where the crane robot and its first barrel appear. */
export function robotArea(stage: Stage, input: StageInput): { col0: number; col1: number; row0: number; row1: number } {
  const topGirder = stage.gy - 108;
  return {
    col0: Math.max(0, Math.floor((stage.width - 100) * stage.scale / input.cellWidth)), col1: input.cols,
    row0: Math.max(0, Math.floor((topGirder - 50) * stage.scale / input.cellHeight)), row1: Math.min(input.rows, Math.ceil(topGirder * stage.scale / input.cellHeight)),
  };
}
/** True when no cell of the area holds text; only then the robot may appear. */
export function areaFree(lines: string[], area: { col0: number; col1: number; row0: number; row1: number }): boolean {
  for (let row = area.row0; row < area.row1; row++) if ((lines[row] ?? "").slice(area.col0, area.col1).trim() !== "") return false;
  return true;
}
export interface ActionPlan { design: RetroId; action: ActionId; stage: Stage }
/** Chooses the action of this phase; null if the terminal is too small. The robot action needs a free top right corner. */
export function planAction(design: RetroId, input: StageInput, rng: Rng): ActionPlan | null {
  const stage = pickStage(design, input);
  if (!stage) return null;
  const choices = actionsByDesign[design].filter(action => action !== "barrels" || areaFree(input.lines, robotArea(stage, input)));
  return { design, action: choices[Math.min(choices.length - 1, Math.floor(rng() * choices.length))], stage };
}

// ---------- ?-blocks (Retro Hüpfer) ----------
export type BlockItem = "coin" | "fish" | "star" | "feather";
/** A ?-block holds `left` items of one kind; when none is left it stays as an empty, brown block. */
export interface Block { x: number; brick: boolean; item: BlockItem; left: number; bump: number }
export const blockFull = (block: Block): boolean => !block.brick && block.left > 0;
/** Hit from below: the block bumps; returns the item that comes out, or null for bricks and empty blocks. */
export function hitBlock(block: Block): BlockItem | null {
  block.bump = 0;
  if (!blockFull(block)) return null;
  block.left--;
  return block.item;
}
