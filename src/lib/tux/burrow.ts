import type { ActionId, Rng } from "./actions";
import { between, clamp, sgn, stepParticles, type Layout, type Particle, type Scene } from "./scene";
// Retro Lemminge: stopper, digger, parachute, builder, exit door. Ported from the approved preview (virtual pixels).
export type LemSprite = "stand" | "sideA" | "sideB" | "stopA" | "stopB" | "digFA" | "digFB" | "hang" | "buildA" | "buildB";
export type LemMode = "walk" | "stop" | "dig" | "gone" | "chute" | "land" | "lay" | "move" | "enter";
export interface BurrowActor {
  x: number; y: number; cx: number; dir: number; speed: number; mode: LemMode; t: number; mt: number; vy: number; free: boolean;
  stopAt: number | null; onStop: LemMode; stopTime: number; alpha: number; dead: boolean; spr: LemSprite; sink: number; clipY: number | null; hidden: boolean;
  hole: LemHole | null; bx: number; i: number; target: number;
}
export interface LemHole { x: number; w: number; open: number; a: number; closing: boolean }
export interface LemStep { x: number; y: number; a: number; ttl: number | null }
export interface LemDoor { x: number; a: number; f: number; t: number; state: "in" | "open" | "out"; expected: BurrowActor[] }
export const DIRT = ["#c4a67d", "#8a6b45", "#6b4f2e"];
export class BurrowScene implements Scene {
  actors: BurrowActor[] = []; steps: LemStep[] = []; holes: LemHole[] = []; parts: Particle[] = [];
  door: LemDoor | null = null; time = 0;
  private watch: () => boolean = () => true;
  constructor(readonly action: ActionId, readonly layout: Layout, private rng: Rng) {
    const at = (x: number) => x / 640 * layout.width;
    switch (action) {
      case "stopper": {
        const s = this.add({ x: at(200), speed: 46, free: true, stopAt: at(300), onStop: "stop", stopTime: 8 });
        const w1 = this.add({ x: -30, speed: 52, free: true }), w2 = this.add({ x: -100, speed: 50, free: true });
        this.watch = () => [s, w1, w2].every(a => a.dead); break;
      }
      case "digger": { const g = this.add({ x: at(200), speed: 48, free: true, stopAt: at(392), onStop: "dig" }); this.watch = () => g.dead && this.holes.length === 0; break; }
      case "parachute": {
        const a1 = this.add({ x: at(160), cx: at(160), y: -34, mode: "chute", free: true }), a2 = this.add({ x: at(440), cx: at(440), y: -100, mode: "chute", free: true });
        this.watch = () => a1.dead && a2.dead; break;
      }
      case "builder": { const b = this.add({ x: 20, speed: 48, free: true, stopAt: at(120), onStop: "lay" }); this.watch = () => b.dead && this.steps.length === 0; break; }
      default: {
        const a = this.add({ x: at(380), speed: 56, free: true, stopAt: at(530), onStop: "enter" }), b = this.add({ x: at(320), speed: 56, free: true, stopAt: at(530), onStop: "enter" });
        this.door = { x: at(520), a: 0, f: 0, t: 0, state: "in", expected: [a, b] };
        this.watch = () => this.door === null;
      }
    }
  }
  get done(): boolean { return this.watch(); }
  private add(o: Partial<BurrowActor>): BurrowActor {
    const a: BurrowActor = { x: 0, y: this.layout.gy, cx: 0, dir: 1, speed: 42, mode: "walk", t: between(this.rng, 0, 3), mt: 0, vy: 0, free: false, stopAt: null, onStop: "walk", stopTime: 8, alpha: 1, dead: false, spr: "stand", sink: 0, clipY: null, hidden: false, hole: null, bx: 0, i: 0, target: 0, ...o };
    this.actors.push(a); return a;
  }
  /** Ground below x: the highest step the actor can stand on, else the ground line. */
  private support(x: number, y: number): number {
    let s = this.layout.gy;
    for (const st of this.steps) if (x >= st.x && x < st.x + 16 && st.y < s && st.y >= y - 5) s = st.y;
    return s;
  }
  private physics(a: BurrowActor, dt: number): void {
    const t = this.support(a.x, a.y);
    if (a.y > t) { a.y = t; a.vy = 0; }
    else if (a.y < t) { a.vy += 500 * dt; a.y = Math.min(t, a.y + a.vy * dt); if (a.y >= t) a.vy = 0; }
  }
  private startDig(a: BurrowActor): void {
    const hole: LemHole = { x: a.x - 22, w: 44, open: 0, a: 1, closing: false };
    this.holes.push(hole); a.hole = hole; a.mt = 0;
  }
  private stepActor(a: BurrowActor, dt: number): void {
    const gy = this.layout.gy, width = this.layout.width;
    a.t += dt;
    switch (a.mode) {
      case "walk": {
        for (const b of this.actors) if (b !== a && b.mode === "stop" && Math.abs(a.x - b.x) < 22 && sgn(b.x - a.x) === a.dir) a.dir = -a.dir;
        for (const s of this.steps) if (s.y < a.y - 5 && Math.abs(a.x - (s.x + 8)) < 14 && sgn(s.x + 8 - a.x) === a.dir) a.dir = -a.dir;
        a.x += a.dir * a.speed * dt;
        if (a.stopAt !== null && (a.dir > 0 ? a.x >= a.stopAt : a.x <= a.stopAt)) {
          a.x = a.stopAt; a.stopAt = null; a.mode = a.onStop; a.mt = 0;
          if (a.mode === "dig") this.startDig(a);
          if (a.mode === "lay") { a.bx = a.x + 6; a.i = 0; }
        }
        if (!a.free) { a.x = clamp(a.x, 20, width - 20); }
        else if ((a.dir < 0 && a.x < -60) || (a.dir > 0 && a.x > width + 60)) a.dead = true;
        this.physics(a, dt);
        a.spr = a.y < this.support(a.x, a.y) ? "stand" : (Math.floor(a.t * 6) % 2 ? "sideA" : "sideB");
        break;
      }
      case "stop": a.mt += dt; a.spr = Math.floor(a.t * 4) % 2 ? "stopA" : "stopB"; if (a.mt >= a.stopTime) { a.mode = "walk"; a.dir = 1; } break;
      case "dig": {
        a.mt += dt; const p = clamp(a.mt / 4.5, 0, 1);
        a.spr = Math.floor(a.t * 5) % 2 ? "digFA" : "digFB"; a.clipY = gy; a.sink = p * 34;
        if (a.hole) a.hole.open = clamp(p * 1.6, 0, 1);
        if (this.rng() < dt * 16) this.parts.push({ x: a.x + between(this.rng, -8, 8), y: gy - 2, vx: between(this.rng, -60, 60), vy: between(this.rng, -110, -50), life: .7, c: DIRT[Math.floor(this.rng() * 3) % 3] });
        if (p >= 1) { a.mode = "gone"; a.mt = 0; a.hidden = true; if (a.hole) a.hole.closing = true; }
        break;
      }
      case "gone": a.mt += dt; if (a.mt >= 1.4) { a.mode = "walk"; a.hidden = false; a.sink = 0; a.clipY = null; a.x = -34; a.dir = 1; a.y = gy; a.speed = 70; } break;
      case "chute": a.y += 38 * dt; a.x = a.cx + Math.sin(a.t * 1.6) * 10; a.spr = "hang"; if (a.y >= gy) { a.y = gy; a.mode = "land"; a.mt = 0; a.spr = "stand"; } break;
      case "land": a.mt += dt; a.spr = "stand"; if (a.mt >= .55) { a.mode = "walk"; a.dir = this.rng() < .5 ? -1 : 1; a.speed = 50; } break;
      case "lay":
        a.mt += dt; a.spr = Math.floor(a.t * 4) % 2 ? "buildA" : "buildB"; this.physics(a, dt);
        if (a.mt >= .8) { const sx = a.bx + 16 * a.i; this.steps.push({ x: sx, y: gy - 4 * (a.i + 1), a: 1, ttl: null }); a.target = sx + 8; a.mode = "move"; }
        break;
      case "move":
        a.x += 40 * dt; this.physics(a, dt); a.spr = Math.floor(a.t * 6) % 2 ? "sideA" : "sideB";
        if (a.x >= a.target) {
          a.i++;
          if (a.i >= 5) { a.mode = "walk"; a.dir = 1; a.speed = 46; a.free = true; this.steps.forEach(s => { s.ttl = 3.5; }); }
          else { a.mode = "lay"; a.mt = 0; }
        }
        break;
      case "enter": a.mt += dt; a.alpha = clamp(1 - a.mt / .5, 0, 1); a.x += a.dir * 20 * dt; a.spr = "sideA"; if (a.mt >= .5) a.dead = true; break;
    }
  }
  private stepDoor(door: LemDoor, dt: number): void {
    door.t += dt;
    if (door.state === "in") { door.a = clamp(door.t / .5, 0, 1); door.f = door.t < .5 ? 0 : door.t < .8 ? 1 : 2; if (door.t > .8) door.state = "open"; }
    else if (door.state === "open") { door.f = 2; if (door.expected.every(x => x.dead)) { door.state = "out"; door.t = 0; } }
    else { door.f = door.t < .25 ? 1 : 0; door.a = door.t < .5 ? 1 : clamp(1 - (door.t - .5) / .4, 0, 1); if (door.t > .9) this.door = null; }
  }
  step(dt: number): void {
    dt = clamp(dt, 0, .1); this.time += dt;
    this.actors.forEach(a => this.stepActor(a, dt));
    this.actors = this.actors.filter(a => !a.dead);
    for (const s of this.steps) if (s.ttl !== null) { s.ttl -= dt; if (s.ttl < 0) s.a -= dt * 1.5; }
    this.steps = this.steps.filter(s => s.a > 0);
    for (const h of this.holes) if (h.closing) h.a -= dt;
    this.holes = this.holes.filter(h => h.a > 0);
    stepParticles(this.parts, dt);
    if (this.door) this.stepDoor(this.door, dt);
  }
}
