import { flip, pick, rint, rnd, clamp, SimBase, Surfaces, type Dir, type Grid, type Plank, type Rng } from "./retroGrid";
// Retro Lemminge: Tuxes drop out of a hatch and walk on soil. Only every 2nd row (counted from the ground) is soil;
// the rows in between stay readable text without floor, so one level is two rows. Words of digits and paths are
// steel and cannot be dug. Tuxes dig by hand straight down, as a tunnel through a word or diagonally; on steel they
// shrug and turn round. Every 3rd to 4th Tux carries an umbrella, every 4th to 5th one can climb a wall one level up.
// A fall of more than 3 rows (61 pixels at 20-pixel rows: one level survives, two only with umbrella) ends in a puff,
// the first drop out of the hatch does not count. Stoppers and stair builders (5 steps of 8 pixels, one level), the
// door at the bottom lets them out. On terminal activity all Tuxes pop from left to right within ~0.75 seconds.
export type LemmingeState = "enter" | "fall" | "float" | "walk" | "dig" | "tunnel" | "diag" | "shrug" | "climb" | "stop" | "build" | "die" | "exit" | "vanish" | "pop";
export type LemmingeRole = "dig" | "tunnel" | "diag" | "stop" | "build";
export type DigKind = "dig" | "tunnel" | "diag";
export interface LemmingeTux {
  id: number; x: number; y: number; vy: number; dir: Dir; state: LemmingeState; t: number; umbrella: boolean; climber: boolean;
  /** Still on the first drop out of the hatch: that fall never kills. */
  fresh: boolean;
  fallStart: number; row: number; anim: number; cool: number; dur: number; stage: number; dc: number; dr: number; crumbT: number;
  bx: number; by: number; placed: number; dead: boolean; leaveT: number; pending: LemmingeRole | null;
  /** Dig state: start y, tunnel phase, tunnel column and length, timers, diagonal start, cells dug. */
  y0: number; sinking: boolean; tc: number; len: number; tt: number; x0: number; dk: number;
  /** After the shrug: turn round, or come up on the steel plate first (tunnel). */
  after: "turn" | "emerge"; en: number;
  /** Climb: target row, its floor y, target column, the floor y the climb started from. */
  crow: number; cy: number; ccol: number; cfrom: number;
  /** Exit on activity: time at which the Tux pops. */
  popAt: number;
}
export interface LemmingeStair extends Plank { age: number }
export interface Hatch { x: number; t: number }
export const WALK = 30, FLOAT_V = 42, CLIMB_V = 24, GRAV = 720, ENTRY_Y = 18, SAFE_ROWS = 3, MAX_TUXES = 6, RISE = 8, STEPS = 5, TUNNEL_MAX = 7;
/** Exit on activity: at most this long between two pops, one pop lasts POP_TIME. */
export const POP_GAP = 0.12, POP_TIME = 0.3;
const CRUMB = ["#8a5a2b", "#b57a3d", "#6b4a2a"], PUFF = ["#4a5d7a", "#f1f5ee", "#7ccf3a", "#ffe9a8"], DIRT = ["#8a5a2b", "#b57a3d", "#ffe9a8"];

export class LemmingeSim extends SimBase {
  readonly id = "lemminge" as const;
  tuxes: LemmingeTux[] = [];
  steps: LemmingeStair[] = [];
  hatches: Hatch[] = [];
  stats = { saved: 0, died: 0, floated: 0, climbed: 0, dug: 0, shrugs: 0 };
  readonly doorX: number;
  doorT = 0;
  spawnT = 1;
  /** True once the first Tux came in: soil and steel replace the text of the soil rows until the overlay ends. */
  started = false;
  private umbrellaIn: number;
  private climbIn: number;
  private readonly surfaces: Surfaces;
  constructor(grid: Grid, readonly groundRow: number, rng: Rng, leaveAfter?: number) {
    super(grid, rng, leaveAfter);
    this.doorX = grid.width - 70;
    this.umbrellaIn = rint(rng, 3, 4);
    this.climbIn = rint(rng, 4, 5);
    this.surfaces = new Surfaces(grid, groundRow, true, () => this.steps);
  }
  get done(): boolean { return this.closing && this.tuxes.length === 0; }
  /** Soil view: only while Tuxes are active; idle shows the normal text. */
  get tiles(): boolean { return this.started && !this.done; }
  /** A soil row (with floor, above the ground): its characters are drawn as clods of soil or steel plates. */
  soilRow(r: number): boolean { return r >= 1 && r < this.groundRow && this.grid.floorRow(r); }
  /** Entry column: preferably one where the first floor lies in row 1 to 3 (long way down); the first drop never kills. */
  private entryX(): number {
    const g = this.grid, lo = 3, hi = Math.max(lo, g.cols - 10);
    for (let i = 0; i < 40; i++) {
      const c = rint(this.rng, lo, hi);
      if (this.surfaces.firstRow(c) <= 3) return (c + 0.5) * g.cw;
    }
    return (rint(this.rng, lo, hi) + 0.5) * g.cw;
  }
  spawn(o: { x?: number; umbrella?: boolean; climber?: boolean; pending?: LemmingeRole } = {}): LemmingeTux {
    let umbrella = o.umbrella, climber = o.climber ?? false;
    if (umbrella === undefined) {
      this.umbrellaIn--; this.climbIn--;
      umbrella = this.umbrellaIn <= 0;
      if (umbrella) this.umbrellaIn = rint(this.rng, 3, 4);
      // Both counters due at once: this one gets the umbrella, the next one climbs.
      if (!umbrella && this.climbIn <= 0 && o.climber === undefined) { climber = true; this.climbIn = rint(this.rng, 4, 5); }
    }
    const x = o.x ?? this.entryX();
    const t: LemmingeTux = {
      id: this.nextId++, x, y: ENTRY_Y, vy: 0, dir: this.rng() < 0.5 ? -1 : 1, state: "enter", t: 0, umbrella, climber, fresh: o.x === undefined,
      fallStart: ENTRY_Y, row: -2, anim: 0, cool: 0, dur: 0, stage: 0, dc: 0, dr: 0, crumbT: 0, bx: 0, by: 0, placed: -1, dead: false,
      leaveT: rnd(this.rng, 0, 4), pending: o.pending ?? null, y0: 0, sinking: false, tc: 0, len: 0, tt: 0, x0: 0, dk: 0, after: "turn", en: 0,
      crow: 0, cy: 0, ccol: 0, cfrom: 0, popAt: 0,
    };
    this.tuxes.push(t); this.hatches.push({ x, t: 0 }); this.started = true;
    return t;
  }
  private puff(x: number, y: number): void {
    for (let i = 0; i < 14; i++) { const a = i / 14 * Math.PI * 2; this.parts.add(x, y, Math.cos(a) * 60, Math.sin(a) * 60 - 20, 0.5, pick(this.rng, PUFF), 3, 100); }
  }
  /** Removes a clod of soil; steel never goes. */
  private crumble(r: number, c: number): boolean {
    if (this.grid.isSteel(r, c)) return false;
    if (this.grid.destroy(r, c) && this.grid.hasText(r, c)) for (let i = 0; i < 3; i++) this.parts.add(c * this.grid.cw + 4 + rnd(this.rng, -3, 3), this.grid.floorY(r), rnd(this.rng, -25, 25), rnd(this.rng, -40, 10), rnd(this.rng, 0.5, 1), pick(this.rng, CRUMB), 2, 500);
    return true;
  }
  private fallFrom(t: LemmingeTux): void { t.state = "fall"; t.fallStart = t.y; t.vy = 0; t.t = 0; t.row = -2; }
  /** Can a Tux dig here (row r, column c, direction d)? Needs clods of soil: "no" over gaps, "steel" if steel is in the way. */
  digStatus(kind: DigKind, r: number, c: number, d: Dir): "ok" | "steel" | "no" {
    const need = kind === "dig" ? [c] : kind === "tunnel" ? [c, c + d] : [0, 1, 2, 3].map(i => c + d * i);
    let steel = false;
    for (const cc of need) {
      if (!this.grid.hasChar(r, cc)) return "no";
      if (this.grid.isSteel(r, cc)) steel = true;
    }
    return steel ? "steel" : "ok";
  }
  begin(t: LemmingeTux, kind: LemmingeRole): boolean {
    if (t.state !== "walk") return false;
    if (kind === "dig" || kind === "tunnel" || kind === "diag") {
      if (t.row < 0 || t.row >= this.groundRow) return false;
      const c = this.grid.colOf(t.x), st = this.digStatus(kind, t.row, c, t.dir);
      if (st === "no") return false;
      t.x = (c + 0.5) * this.grid.cw;
      if (st === "steel") { t.state = "shrug"; t.t = 0; t.after = "turn"; t.cool = 4; this.stats.shrugs++; return true; }
      this.stats.dug++; t.dr = t.row; t.y0 = t.y; t.crumbT = 0; t.t = 0;
      if (kind === "dig") { t.state = "dig"; t.stage = 0; t.dc = c; }
      else if (kind === "tunnel") { t.state = "tunnel"; t.sinking = true; t.tc = c; t.len = 0; t.tt = 0; }
      else { t.state = "diag"; t.dc = c; t.x0 = t.x; t.dk = 0; }
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
  private stairAt(t: LemmingeTux, i: number): { x1: number; y: number } { return { x1: t.dir > 0 ? t.bx + 4 + 8 * i : t.bx - 4 - 8 * i - 16, y: t.by - RISE * (i + 1) }; }
  private stairTop(t: LemmingeTux, i: number): { x: number; y: number } { const s = this.stairAt(t, i); return { x: t.dir > 0 ? s.x1 + 10 : s.x1 + 6, y: s.y }; }
  private build(t: LemmingeTux): void {
    const T = 0.6, i = Math.floor(t.t / T);
    if (i >= STEPS) { const e = this.stairTop(t, STEPS - 1); t.x = e.x; t.y = e.y; t.state = "walk"; t.t = 0; t.row = -1; return; }
    if (t.placed < i) { t.placed = i; const s = this.stairAt(t, i); this.steps.push({ x1: s.x1, x2: s.x1 + 16, y: s.y, age: 0 }); }
    const a = i === 0 ? { x: t.bx, y: t.by } : this.stairTop(t, i - 1), b = this.stairTop(t, i), u = clamp((t.t - i * T - 0.3) / 0.3, 0, 1);
    t.x = a.x + (b.x - a.x) * u; t.y = a.y + (b.y - a.y) * u;
  }
  private dust(t: LemmingeTux, dt: number, dx: number, dy: number, every: number, colors: string[]): void {
    t.crumbT -= dt;
    if (t.crumbT <= 0) { t.crumbT = every; this.parts.add(t.x + dx + rnd(this.rng, -4, 4), t.y - dy, rnd(this.rng, -20, 20), rnd(this.rng, -55, -20), 0.45, pick(this.rng, colors), 2, 400); }
  }
  /** Straight down by hand: the clod under the Tux goes after 0.5 s, its neighbours after 1.0 s, then one level down. */
  private dig(t: LemmingeTux, dt: number): void {
    t.anim += dt; this.dust(t, dt, 0, 2, 0.07, DIRT);
    if (t.stage === 0 && t.t > 0.5) { this.crumble(t.dr, t.dc); t.stage = 1; }
    if (t.stage === 1 && t.t > 1.0) { this.crumble(t.dr, t.dc - 1); this.crumble(t.dr, t.dc + 1); t.stage = 2; }
    if (t.t > 1.4) this.fallFrom(t);
  }
  private emerge(t: LemmingeTux, nc: number): void {
    t.state = "walk"; t.t = 0; t.cool = 6; t.y = this.grid.floorY(t.dr); t.row = t.dr;
    if (this.surfaces.solidAt(t.dr, nc)) t.x = (nc + 0.5) * this.grid.cw;
  }
  /** Through a word: sink 12 pixels, then eat one clod every 0.55 s, at most 8; word end or gap: come up again. */
  private tunnel(t: LemmingeTux, dt: number): void {
    t.anim += dt; this.dust(t, dt, t.dir * 8, 6, 0.08, CRUMB);
    if (t.sinking) {
      const u = Math.min(1, t.t / 0.4);
      t.y = t.y0 + 12 * u;
      if (u >= 1) { this.crumble(t.dr, t.tc); t.sinking = false; t.tt = 0; }
      return;
    }
    t.tt += dt;
    const tx = (t.tc + 0.5) * this.grid.cw, d = tx - t.x;
    t.x += Math.sign(d) * Math.min(Math.abs(d), this.grid.cw / 0.45 * dt);
    if (t.tt < 0.55) return;
    t.tt = 0;
    const nc = t.tc + t.dir;
    if (t.len >= TUNNEL_MAX) { this.emerge(t, nc); return; }
    if (this.grid.hasChar(t.dr, nc) && this.grid.isSteel(t.dr, nc)) { t.state = "shrug"; t.t = 0; t.after = "emerge"; t.en = nc; this.stats.shrugs++; return; }
    if (this.grid.hasChar(t.dr, nc)) { this.crumble(t.dr, nc); t.tc = nc; t.len++; return; }
    this.emerge(t, nc);
  }
  /** Diagonally down: over 3 cells, sinking 12 pixels, the 4 clods on the way go one after another; then one level down. */
  private diag(t: LemmingeTux, dt: number): void {
    t.anim += dt; this.dust(t, dt, t.dir * 8, 4, 0.08, CRUMB);
    const u = Math.min(1, t.t / 1.8);
    t.x = t.x0 + t.dir * this.grid.cw * 3 * u; t.y = t.y0 + 12 * u;
    while (t.dk < 4 && t.t > 0.2 + 0.45 * t.dk) { this.crumble(t.dr, t.dc + t.dir * t.dk); t.dk++; }
    if (t.t >= 1.8) this.fallFrom(t);
  }
  private endShrug(t: LemmingeTux): void {
    if (t.after === "emerge") { t.x = (t.en + 0.5) * this.grid.cw; t.y = this.grid.floorY(t.dr); t.row = t.dr; t.cool = Math.max(t.cool, 4); }
    t.dir = flip(t.dir); t.state = "walk"; t.t = 0; t.after = "turn";
  }
  /** A climber at a row end (or hole edge) with floor right behind it one level up climbs that wall. */
  private tryClimb(t: LemmingeTux, nx: number): boolean {
    if (t.row < 3 || t.row > this.groundRow) return false;
    const c = this.grid.colOf(nx), up = t.row - 2;
    if (!this.surfaces.solidAt(up, c)) return false;
    t.state = "climb"; t.t = 0; t.crow = up; t.cy = this.grid.floorY(up); t.ccol = c; t.cfrom = t.y;
    t.x = t.dir > 0 ? c * this.grid.cw : (c + 1) * this.grid.cw;
    return true;
  }
  private climb(t: LemmingeTux, dt: number): void {
    t.anim += dt; t.y -= CLIMB_V * dt;
    if (t.y <= t.cy) { t.y = t.cy; t.state = "walk"; t.t = 0; t.row = t.crow; t.x = (t.ccol + 0.5) * this.grid.cw; t.cool = 3; this.stats.climbed++; }
  }
  private land(t: LemmingeTux, s: { y: number; row: number }): void {
    const wasFalling = t.state === "fall";
    t.y = s.y; t.row = s.row;
    if (wasFalling && !t.fresh && s.y - t.fallStart > SAFE_ROWS * this.grid.ch + 1) { t.state = "die"; t.t = 0; this.puff(t.x, t.y - 12); this.stats.died++; return; }
    t.fresh = false; t.state = "walk"; t.t = 0;
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
      if (t.row >= 0 && r < 0.06 * dt) this.begin(t, r < 0.025 * dt ? "dig" : r < 0.045 * dt ? "tunnel" : "diag");
      else if (r < 0.09 * dt) this.begin(t, "build");
      else if (r < 0.105 * dt) this.begin(t, "stop");
      if (t.state !== "walk") return;
    }
    const nx = t.x + t.dir * WALK * dt;
    if (nx < 14 || nx > this.grid.width - 14) { t.dir = flip(t.dir); return; }
    const g = this.surfaces.nearest(nx, t.y, 6);
    if (!g) {
      if (t.climber && this.tryClimb(t, nx)) return;
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
      case "tunnel": this.tunnel(t, dt); break;
      case "diag": this.diag(t, dt); break;
      case "shrug": t.anim += dt; if (t.t > 0.9) this.endShrug(t); break;
      case "climb": this.climb(t, dt); break;
      case "stop": if (t.t > t.dur) { t.state = "walk"; t.t = 0; } else t.anim += dt; break;
      case "build": this.build(t); break;
      case "die": if (t.t > 0.55) t.dead = true; break;
      case "vanish": case "pop": if (t.t > POP_TIME) t.dead = true; break;
      case "exit": if (t.t > 0.55) { t.dead = true; this.stats.saved++; } break;
    }
  }
  private tick(dt: number): void {
    if (this.doorT > 0) this.doorT -= dt;
    for (const h of this.hatches) h.t += dt;
    this.hatches = this.hatches.filter(h => h.t < 1.3);
  }
  protected step(dt: number): void {
    this.tick(dt);
    for (const s of this.steps) s.age += dt;
    this.steps = this.steps.filter(s => s.age < 15);
    if (!this.closing) {
      this.spawnT -= dt;
      if (this.spawnT <= 0 && this.tuxes.length < MAX_TUXES) { this.spawn(); this.spawnT = rnd(this.rng, 2.2, 4.5); }
    }
    for (const t of this.tuxes) this.updateTux(t, dt);
    this.tuxes = this.tuxes.filter(t => !t.dead);
  }
  /** All Tuxes pop from left to right, at most POP_GAP apart (at most ~0.75 s in total), also in mid-fall. */
  protected startExit(): void {
    const list = this.tuxes.slice().sort((a, b) => a.x - b.x), gap = Math.min(POP_GAP, 0.5 / Math.max(1, list.length));
    list.forEach((t, i) => { t.popAt = this.time + i * gap; });
  }
  protected exitStep(dt: number): void {
    this.tick(dt);
    for (const t of this.tuxes) {
      t.t += dt;
      if (t.state === "pop") { if (t.t > POP_TIME) t.dead = true; continue; }
      if (this.time >= t.popAt) { t.state = "pop"; t.t = 0; this.puff(t.x, t.y - 12); continue; }
      if (t.state === "fall" || t.state === "float") this.fall(t, dt);
    }
    this.tuxes = this.tuxes.filter(t => !t.dead);
  }
}
