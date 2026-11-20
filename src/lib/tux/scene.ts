import type { Rng } from "./actions";
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const sgn = (v: number) => (v < 0 ? -1 : 1);
export const ease = (v: number) => 1 - (1 - clamp(v, 0, 1)) ** 2;
export const between = (rng: Rng, a: number, b: number) => a + rng() * (b - a);
/** Layout in virtual pixels (see Stage): width of the stage and y of the ground line. */
export interface Layout { width: number; gy: number }
/** Shared by all action scenes; the overlay steps them and draws their state. */
export interface Scene { readonly done: boolean; step(dt: number): void }
export interface Particle { x: number; y: number; vx: number; vy: number; life: number; c: string }
export function stepParticles(parts: Particle[], dt: number): void {
  for (const p of parts) { p.life -= dt; p.vy += 420 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].life <= 0) parts.splice(i, 1);
}
/** Safety net: no scene runs longer than this many seconds. */
export const SCENE_TIMEOUT = 75;
