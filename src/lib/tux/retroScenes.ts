import type { ActionPlan, Rng } from "./actions";
import { JumperScene } from "./jumper";
import { BurrowScene } from "./burrow";
import { drawJumper, drawBurrow, drawScaffold } from "./retroDraw";
import { retroLooks } from "./retroSprites";
import { ScaffoldScene } from "./scaffold";
export type RetroScene = BurrowScene | ScaffoldScene | JumperScene;
export function createScene(plan: ActionPlan, rng: Rng): RetroScene {
  const layout = { width: plan.stage.width, gy: plan.stage.gy };
  return plan.design === "lemminge" ? new BurrowScene(plan.action, layout, rng) : plan.design === "geruest" ? new ScaffoldScene(plan.action, layout, rng) : new JumperScene(plan.action, layout, rng);
}
/** Draws a scene; the context must already be translated to the stage origin and scaled by stage.scale. */
export function drawScene(ctx: CanvasRenderingContext2D, scene: RetroScene, plan: ActionPlan, ground: string): void {
  const look = retroLooks[plan.design];
  if (scene instanceof BurrowScene) drawBurrow(ctx, scene, look, { ground });
  else if (scene instanceof ScaffoldScene) drawScaffold(ctx, scene, look);
  else drawJumper(ctx, scene, look, scene.time);
}
