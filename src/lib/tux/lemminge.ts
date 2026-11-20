import { flip, pick, rint, rnd, clamp, SimBase, Surfaces, type Dir, type Grid, type Plank, type Rng } from "./retroGrid";
// Retro Lemminge: Tuxes drop out of a hatch, walk the text rows and dig through them by hand. Every 3rd to 4th Tux
// carries an umbrella; a fall of more than three rows without one is fatal (squash and a pixel puff, no blood).
// Individual Tuxes become stoppers or stair builders. At the bottom the door lets them out.
export type LemmingeState = "enter" | "fall" | "float" | "walk" | "dig" | "stop" | "build" | "die" | "exit" | "vanish";
export type LemmingeRole = "dig" | "stop" | "build";
export interface LemmingeTux {
  id: number; x: number; y: number; vy: number; dir: Dir; state: LemmingeState; t: number; umbrella: boolean;
  fallStart: number; row: number; anim: number; cool: number; dur: number; stage: number; dc: number; dr: number; crumbT: number;
  bx: number; by: number; placed: number; dead: boolean; leaveT: number; pending: LemmingeRole | null;
}
export interface LemmingeStair extends Plank { age: number }
export interface Hatch { x: number; t: number }
export const WALK = 30, FLOAT_V = 42, GRAV = 720, ENTRY_Y = 18, SAFE_ROWS = 3, MAX_TUXES = 6;
const CRUMB = ["#e3d8b8", "#8fd14f", "#6fa8ff"], PUFF = ["#4a5d7a", "#f1f5ee", "#7ccf3a", "#ffe9a8"], DIRT = ["#8a5a2b", "#b57a3d", "#ffe9a8"];

export class LemmingeSim extends SimBase {
  readonly id = "lemminge" as const;
  tuxes: LemmingeTux[] = [];
  steps: LemmingeStair[] = [];
  hatches: Hatch[] = [];
  stats = { saved: 0, died: 0, floated: 0 };
  readonly doorX: number;
  doorT = 0;
  spawnT = 1;
  private umbrellaIn: number;
  private readonly surfaces: Surfaces;
  constructor(grid: Grid, readonly groundRow: number, rng: Rng, leaveAfter?: number) {
    super(grid, rng, leaveAfter);
    this.doorX = grid.width - 70;
    this.umbrellaIn = rint(rng, 3, 4);
    this.surfaces = new Surfaces(grid, groundRow, true, () => this.steps);
  }
  get done(): boolean { return this.closing && this.tuxes.length === 0; }
  /** Entry column: a normal Tux needs a first fall of at most three rows, an umbrella Tux may drop anywhere. */
  private entry(umbrella: boolean): { x: number; umbrella: boolean } {
    const lo = 3, hi = Math.max(lo, this.grid.cols - 10), g = this.grid;
    for (let i = 0; i < 40; i++) {
      const c = rint(this.rng, lo, hi);
      if (umbrella || g.floorY(this.surfaces.firstRow(c)) - ENTRY_Y <= SAFE_ROWS * g.ch + 1) return { x: (c + 0.5) * g.cw, umbrella };
    }
    return { x: (rint(this.rng, lo, hi) + 0.5) * g.cw, umbrella: true };
  }
  spawn(o: { x?: number; umbrella?: boolean; pending?: LemmingeRole } = {}): LemmingeTux {
    let umbrella = o.umbrella;
    if (umbrella === undefined) {
      this.umbrellaIn--; umbrella = this.umbrellaIn <= 0;
      if (umbrella) this.umbrellaIn = rint(this.rng, 3, 4);
    }
    let x = o.x;
    if (x === undefined) { const e = this.entry(umbrella); x = e.x; umbrella = e.umbrella; }
    const t: LemmingeTux = {
      id: this.nextId++, x, y: ENTRY_Y, vy: 0, dir: this.rng() < 0.5 ? -1 : 1, state: "enter", t: 0, umbrella, fallStart: ENTRY_Y, row: -2, anim: 0, cool: 0,
      dur: 0, stage: 0, dc: 0, dr: 0, crumbT: 0, bx: 0, by: 0, placed: -1, dead: false, leaveT: rnd(this.rng, 0, 4), pending: o.pending ?? null,
    };
    this.tuxes.push(t); this.hatches.push({ x, t: 0 });
    return t;
  }
  private puff(x: number, y: number): void {
    for (let i = 0; i < 14; i++) { const a = i / 14 * Math.PI * 2; this.parts.add(x, y, Math.cos(a) * 60, Math.sin(a) * 60 - 20, 0.5, pick(this.rng, PUFF), 3, 100); }
  }
  private crumble(r: number, c: number): void {
    if (this.grid.destroy(r, c) && this.grid.hasText(r, c)) for (let i = 0; i < 3; i++) this.parts.add(c * this.grid.cw + 4 + rnd(this.rng, -3, 3), this.grid.floorY(r), rnd(this.rng, -25, 25), rnd(this.rng, -40, 10), rnd(this.rng, 0.5, 1), pick(this.rng, CRUMB), 2, 500);
  }
  private fallFrom(t: LemmingeTux): void { t.state = "fall"; t.fallStart = t.y; t.vy = 0; t.t = 0; t.row = -2; }
  begin(t: LemmingeTux, kind: LemmingeRole): boolean {
    if (t.state !== "walk") return false;
    if (kind === "dig") {
      if (t.row < 0 || t.row >= this.groundRow) return false;
      t.x = (this.grid.colOf(t.x) + 0.5) * this.grid.cw; t.state = "dig"; t.t = 0; t.stage = 0; t.dc = this.grid.colOf(t.x); t.dr = t.row; t.crumbT = 0;
    } else if (kind === "stop") {
      if (t.row === this.groundRow || this.tuxes.some(o => o.state === "stop")) return false;
      t.state = "stop"; t.t = 0; t.dur = rnd(this.rng, 6, 9);
    } else {
      if (t.y < 60) return false;
      t.state = "build"; t.t = 0; t.bx = t.x; t.by = t.y; t.placed = -1;
    }
    t.cool = 9;
    return true;
  }
  private stairAt(t: LemmingeTux, i: number): { x1: number; y: number } { return { x1: t.dir > 0 ? t.bx + 4 + 8 * i : t.bx - 4 - 8 * i - 16, y: t.by - 4 * (i + 1) }; }
  private stairTop(t: LemmingeTux, i: number): { x: number; y: number } { const s = this.stairAt(t, i); return { x: t.dir > 0 ? s.x1 + 10 : s.x1 + 6, y: s.y }; }
  private build(t: LemmingeTux): void {
    const T = 0.6, i = Math.floor(t.t / T);
    if (i >= 5) { const e = this.stairTop(t, 4); t.x = e.x; t.y = e.y; t.state = "walk"; t.t = 0; t.row = -1; return; }
    if (t.placed < i) { t.placed = i; const s = this.stairAt(t, i); this.steps.push({ x1: s.x1, x2: s.x1 + 16, y: s.y, age: 0 }); }
    const a = i === 0 ? { x: t.bx, y: t.by } : this.stairTop(t, i - 1), b = this.stairTop(t, i), u = clamp((t.t - i * T - 0.3) / 0.3, 0, 1);
    t.x = a.x + (b.x - a.x) * u; t.y = a.y + (b.y - a.y) * u;
  }
  private dig(t: LemmingeTux, dt: number): void {
    t.anim += dt; t.crumbT -= dt;
    if (t.crumbT <= 0) { t.crumbT = 0.07; this.parts.add(t.x + rnd(this.rng, -6, 6), t.y - 2, rnd(this.rng, -20, 20), rnd(this.rng, -60, -20), 0.5, pick(this.rng, DIRT), 2, 400); }
    if (t.stage === 0 && t.t > 0.5) { this.crumble(t.dr, t.dc); t.stage = 1; }
    if (t.stage === 1 && t.t > 1.0) { this.crumble(t.dr, t.dc - 1); this.crumble(t.dr, t.dc + 1); t.stage = 2; }
    if (t.t > 1.4) this.fallFrom(t);
  }
  private land(t: LemmingeTux, s: { y: number; row: number }): void {
    const wasFalling = t.state === "fall";
    t.y = s.y; t.row = s.row;
    if (wasFalling && s.y - t.fallStart > SAFE_ROWS * this.grid.ch + 1) { t.state = "die"; t.t = 0; this.puff(t.x, t.y - 12); this.stats.died++; return; }
    t.state = "walk"; t.t = 0;
  }
  private fall(t: LemmingeTux, dt: number): void {
    if (t.state === "fall" && t.umbrella && t.y - t.fallStart > 18) { t.state = "float"; t.t = 0; this.stats.floated++; }
    if (t.state === "float") {
      t.vy = t.vy > FLOAT_V ? Math.max(FLOAT_V, t.vy - 1800 * dt) : Math.min(FLOAT_V, t.vy + 400 * dt);
      t.x = clamp(t.x + Math.sin(t.t * 3 + t.id) * 9 * dt, 12, this.grid.width - 12);
    } else t.vy += GRAV * dt;
    const ny = t.y + t.vy * dt, s = this.surfaces.landing(t.x, t.y, ny);
    if (s) { this.land(t, s); return; }
    t.y = ny;
    if (t.y > this.grid.height + 40) t.dead = true;
  }
  private walk(t: LemmingeTux, dt: number): void {
    t.anim += dt;
    if (t.pending && t.t > 0.3) { const p = t.pending; t.pending = null; if (this.begin(t, p)) return; }
    if (t.row === this.groundRow) t.dir = this.doorX > t.x ? 1 : -1;
    for (const s of this.tuxes) {
      if (s.state === "stop" && Math.abs(s.y - t.y) < 8) {
        const rel = (s.x - t.x) * t.dir;
        if (rel > 0 && rel < 14) { t.dir = flip(t.dir); t.x += t.dir * 2; return; }
      }
    }
    if (t.row !== this.groundRow && t.cool <= 0 && t.t > 1.2 && !this.closing) {
      const r = this.rng();
      if (t.row >= 0 && r < 0.06 * dt) this.begin(t, "dig");
      else if (r < 0.09 * dt) this.begin(t, "build");
      else if (r < 0.105 * dt) this.begin(t, "stop");
      if (t.state !== "walk") return;
    }
    const nx = t.x + t.dir * WALK * dt;
    if (nx < 14 || nx > this.grid.width - 14) { t.dir = flip(t.dir); return; }
    const g = this.surfaces.nearest(nx, t.y, 6);
    if (!g) {
      if (this.rng() < 0.35) { t.dir = flip(t.dir); return; }
      t.x = nx; this.fallFrom(t); return;
    }
    t.x = nx; t.y = g.y; t.row = g.row;
    if (t.row === this.groundRow && Math.abs(t.x - this.doorX) < 3) { t.state = "exit"; t.t = 0; this.doorT = 0.9; }
  }
  private updateTux(t: LemmingeTux, dt: number): void {
    t.t += dt;
    if (t.cool > 0) t.cool -= dt;
    if (this.closing && t.state !== "die" && t.state !== "exit" && t.state !== "vanish" && t.state !== "enter") {
      t.leaveT -= dt;
      if (t.leaveT <= 0) { this.puff(t.x, t.y - 12); t.state = "vanish"; t.t = 0; return; }
    }
    switch (t.state) {
      case "enter": if (t.t > 0.45) { t.state = "fall"; t.t = 0; t.fallStart = t.y; } break;
      case "fall": case "float": this.fall(t, dt); break;
      case "walk": this.walk(t, dt); break;
      case "dig": this.dig(t, dt); break;
      case "stop": if (t.t > t.dur) { t.state = "walk"; t.t = 0; } else t.anim += dt; break;
      case "build": this.build(t); break;
      case "die": if (t.t > 0.55) t.dead = true; break;
      case "vanish": if (t.t > 0.3) t.dead = true; break;
      case "exit": if (t.t > 0.55) { t.dead = true; this.stats.saved++; } break;
    }
  }
  protected step(dt: number): void {
    if (this.doorT > 0) this.doorT -= dt;
    for (const h of this.hatches) h.t += dt;
    this.hatches = this.hatches.filter(h => h.t < 1.3);
    for (const s of this.steps) s.age += dt;
    this.steps = this.steps.filter(s => s.age < 15);
    if (!this.closing) {
      this.spawnT -= dt;
      if (this.spawnT <= 0 && this.tuxes.length < MAX_TUXES) { this.spawn(); this.spawnT = rnd(this.rng, 2.2, 4.5); }
    }
    for (const t of this.tuxes) this.updateTux(t, dt);
    this.tuxes = this.tuxes.filter(t => !t.dead);
  }
}
