import type { ActionId, Rng } from "./actions";
import { between, clamp, sgn, type Layout, type Scene } from "./scene";
// Retro Gerüst: girders and ladders appear for the action only. A crane robot top right throws barrels,
// Tuxes climb, jump over barrels and raise a flag at the top. Ported from the approved preview (virtual pixels).
export type GerSprite = "stand" | "sideA" | "sideB" | "climbA" | "climbB" | "jumpG" | "cheer";
export interface Girder { y: number; x0: number; x1: number; dir: number }
export interface Ladder { x: number; top: number; bot: number }
export interface GerActor {
  x: number; y: number; gi: number; dir: number; mode: "walk" | "jump" | "climb" | "toflag" | "flag" | "fade"; t: number; alpha: number; dead: boolean;
  random: boolean; script: number[] | null; goal: boolean; temp: boolean; lcool: number; cool: number; yo: number; spr: GerSprite; jt: number; ft: number; lad: Ladder | null; up: boolean;
}
export interface Barrel { mode: "toss" | "roll" | "ladder" | "fall"; t: number; x: number; y: number; gi: number; dir: number; skip: Set<Ladder>; dead: boolean; lad: Ladder | null; vx: number; vy: number }
export interface Robot { s: "in" | "lift" | "throw" | "idle" | "out"; t: number; a: number; n: number }
export interface Flag { t: number; owner: GerActor }
/** Barrels one robot throws per action. */
export const BARRELS_PER_ACTION = 3;
export class ScaffoldScene implements Scene {
  girders: Girder[]; ladders: Ladder[]; actors: GerActor[] = []; barrels: Barrel[] = [];
  robot: Robot | null = null; flag: Flag | null = null; scaffold = 0; time = 0; flagX: number; robotX: number; tossFrom: number; tossTo: number;
  private complete: () => boolean = () => true;
  /** Wandering Tuxes of the barrel action; they leave after this many seconds at the latest. */
  private helpers: GerActor[] = [];
  static readonly HELPER_TIME = 26;
  constructor(readonly action: ActionId, readonly layout: Layout, private rng: Rng) {
    const w = layout.width, g = layout.gy, at = (x: number) => x / 640 * w;
    this.girders = [{ y: g - 108, x0: 40, x1: w - 20, dir: -1 }, { y: g - 54, x0: 0, x1: w - 40, dir: 1 }, { y: g, x0: 20, x1: w, dir: -1 }];
    this.ladders = [{ x: at(150), top: 0, bot: 1 }, { x: at(470), top: 0, bot: 1 }, { x: at(300), top: 1, bot: 2 }, { x: at(560), top: 1, bot: 2 }];
    this.flagX = 70; this.robotX = w - 71; this.tossFrom = w - 68; this.tossTo = w - 92;
    switch (action) {
      case "barrels": {
        this.robot = { s: "in", t: 0, a: 0, n: 0 };
        const t1 = this.add({ x: at(120), gi: 1, dir: 1, random: true, temp: true }), t2 = this.add({ x: at(520), gi: 2, dir: -1, random: true, temp: true });
        this.helpers = [t1, t2];
        this.complete = () => !this.robot && this.barrels.length === 0 && t1.dead && t2.dead;
        break;
      }
      case "climb": {
        const a = this.add({ x: at(380), gi: 1, dir: 1, temp: true, script: [1, 0, 2] });
        this.complete = () => a.dead; break;
      }
      default: {
        const a = this.add({ x: at(120), gi: 1, dir: 1, temp: true, goal: true, script: [0] });
        this.complete = () => a.dead;
      }
    }
  }
  /** Done when the action is over and the scaffold has faded out again. */
  get done(): boolean { return this.complete() && this.scaffold <= 0; }
  private add(o: Partial<GerActor>): GerActor {
    const gi = o.gi ?? 2;
    const a: GerActor = { x: 100, y: this.girders[gi].y, gi, dir: 1, mode: "walk", t: between(this.rng, 0, 3), alpha: 1, dead: false, random: false, script: null, goal: false, temp: false, lcool: 0, cool: 0, yo: 0, spr: "stand", jt: 0, ft: 0, lad: null, up: false, ...o };
    this.actors.push(a); return a;
  }
  private arrive(a: GerActor): void {
    if (a.script && a.script.length) return;
    if (a.gi === 0 && !this.flag && (a.goal || a.random)) { a.mode = "toflag"; return; }
    if (a.temp && !a.random) a.mode = "fade";
  }
  private stepActor(a: GerActor, dt: number): void {
    a.t += dt; if (a.lcool > 0) a.lcool -= dt; if (a.cool > 0) a.cool -= dt;
    const g = this.girders[a.gi];
    switch (a.mode) {
      case "walk": {
        a.y = g.y; const scripted = !!(a.script && a.script.length);
        if (scripted) a.dir = sgn(this.ladders[a.script![0]].x - a.x);
        const prev = a.x; a.x += a.dir * (scripted ? 55 : 30) * dt;
        if (a.cool <= 0) for (const b of this.barrels) if (b.gi === a.gi && b.mode === "roll" && (a.x - b.x) * b.dir > 0 && Math.abs(a.x - b.x) < 44) { a.mode = "jump"; a.jt = 0; a.cool = 1.4; break; }
        if (a.mode !== "walk") break;
        if (!scripted) { if (a.x < g.x0 + 14) { a.x = g.x0 + 14; a.dir = 1; } if (a.x > g.x1 - 14) { a.x = g.x1 - 14; a.dir = -1; } }
        this.ladders.forEach((l, i) => {
          if (a.mode !== "walk" || !((prev - l.x) * (a.x - l.x) <= 0)) return;
          const up = l.bot === a.gi, down = l.top === a.gi; if (!up && !down) return;
          const want = scripted ? a.script![0] === i : (a.random && a.lcool <= 0 && this.rng() < .4);
          if (want) { if (scripted) a.script!.shift(); a.mode = "climb"; a.lad = l; a.up = up; a.x = l.x; }
        });
        a.spr = Math.floor(a.t * 6) % 2 ? "sideA" : "sideB";
        break;
      }
      case "jump": { a.jt += dt; const p = a.jt / .62; a.x += a.dir * 30 * dt; a.yo = -24 * 4 * p * (1 - p); a.spr = "jumpG"; if (p >= 1) { a.mode = "walk"; a.yo = 0; } break; }
      case "climb": {
        const lad = a.lad!; a.yo = 0; const top = this.girders[lad.top].y, bot = this.girders[lad.bot].y;
        a.y += (a.up ? -26 : 26) * dt; a.spr = Math.floor(a.t * 4) % 2 ? "climbA" : "climbB";
        if (a.up ? a.y <= top : a.y >= bot) { a.gi = a.up ? lad.top : lad.bot; a.y = this.girders[a.gi].y; a.mode = "walk"; a.lcool = 3; a.dir = this.rng() < .5 ? -1 : 1; this.arrive(a); }
        break;
      }
      case "toflag": {
        a.y = g.y; a.dir = sgn(this.flagX - a.x); a.x += a.dir * 50 * dt; a.spr = Math.floor(a.t * 8) % 2 ? "sideA" : "sideB";
        if (Math.abs(a.x - this.flagX) < 3) { a.x = this.flagX; a.dir = 1; a.mode = "flag"; a.ft = 0; this.flag = { t: 0, owner: a }; }
        break;
      }
      case "flag": {
        a.ft += dt; a.spr = "cheer"; a.yo = -Math.abs(Math.sin(a.ft * 6)) * 4; if (this.flag && this.flag.owner === a) this.flag.t = a.ft;
        if (a.ft >= 3.6) { a.yo = 0; this.flag = null; a.mode = a.temp && !a.random ? "fade" : "walk"; a.dir = 1; }
        break;
      }
      case "fade": a.alpha -= dt * 1.6; a.spr = "stand"; a.yo = 0; if (this.flag && this.flag.owner === a) this.flag = null; if (a.alpha <= 0) a.dead = true; break;
    }
  }
  private stepBarrel(b: Barrel, dt: number): void {
    b.t += dt;
    const gs = this.girders;
    if (b.mode === "toss") {
      const p = clamp(b.t / .5, 0, 1); b.x = this.tossFrom + (this.tossTo - this.tossFrom) * p; b.y = (gs[0].y - 30) + 30 * p - 18 * Math.sin(Math.PI * p);
      if (p >= 1) { b.mode = "roll"; b.gi = 0; b.dir = -1; b.y = gs[0].y; }
      return;
    }
    const g = gs[b.gi];
    if (b.mode === "roll") {
      const prev = b.x; b.x += b.dir * 75 * dt; b.y = g.y;
      for (const l of this.ladders) if (l.top === b.gi && !b.skip.has(l) && (prev - l.x) * (b.x - l.x) <= 0) { b.skip.add(l); if (this.rng() < .35) { b.mode = "ladder"; b.x = l.x; b.lad = l; break; } }
      if (b.mode === "roll" && ((b.dir < 0 && b.x <= g.x0) || (b.dir > 0 && b.x >= g.x1))) { b.mode = "fall"; b.vx = b.dir * 40; b.vy = 0; }
    } else if (b.mode === "ladder") {
      b.y += 38 * dt; const target = gs[b.lad!.bot].y; if (b.y >= target) { b.gi = b.lad!.bot; b.y = target; b.mode = "roll"; b.dir = gs[b.gi].dir; }
    } else {
      const py = b.y; b.vy += 700 * dt; b.y += b.vy * dt; b.x += b.vx * dt;
      for (let gi = b.gi + 1; gi < gs.length; gi++) { const gg = gs[gi]; if (py <= gg.y && b.y >= gg.y && b.x >= gg.x0 && b.x <= gg.x1) { b.gi = gi; b.y = gg.y; b.mode = "roll"; b.dir = gg.dir; break; } }
      if (b.y > this.layout.gy + 40) b.dead = true;
    }
  }
  private stepRobot(dt: number): void {
    const r = this.robot; if (!r) return;
    r.t += dt;
    switch (r.s) {
      case "in": r.a = clamp(r.t / .5, 0, 1); if (r.t >= .6) { r.s = "lift"; r.t = 0; } break;
      case "lift": if (r.t >= .6) { r.s = "throw"; r.t = 0; r.n++; this.barrels.push({ mode: "toss", t: 0, x: this.tossFrom, y: this.girders[0].y - 30, gi: 0, dir: -1, skip: new Set(), dead: false, lad: null, vx: 0, vy: 0 }); } break;
      case "throw": if (r.t >= .3) { r.s = "idle"; r.t = 0; } break;
      case "idle": if (r.t >= 2.2) { r.s = r.n >= BARRELS_PER_ACTION ? "out" : "lift"; r.t = 0; } break;
      case "out": r.a = clamp(1 - r.t / .5, 0, 1); if (r.t >= .5) this.robot = null; break;
    }
  }
  step(dt: number): void {
    dt = clamp(dt, 0, .1); this.time += dt;
    if (this.time > ScaffoldScene.HELPER_TIME) for (const a of this.helpers) if (a.mode !== "fade" && !a.dead) a.mode = "fade";
    this.actors.forEach(a => this.stepActor(a, dt)); this.actors = this.actors.filter(a => !a.dead);
    this.barrels.forEach(b => this.stepBarrel(b, dt)); this.barrels = this.barrels.filter(b => !b.dead);
    this.stepRobot(dt);
    const finished = this.complete();
    this.scaffold = clamp(this.scaffold + (finished ? -1 : 1) * dt * 2.5, 0, 1);
  }
}
