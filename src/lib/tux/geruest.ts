import { clamp, flip, pick, rint, rnd, SimBase, type Dir, type Grid, type Rng } from "./retroGrid";
// Retro Gerüst: every text row is a girder from its first to its last character, ladders join neighbouring rows.
// Tuxes start bottom left and climb to the flag on the robot girder: the top girder at least 48 pixels below the top
// edge (the second or third one if the text starts higher up), so the robot is always visible. The robot stands at
// its right end, may cover the characters above it, throws barrels and stomps; only the characters of the top three
// text rows crumble. A barrel hit sends the Tux back to the start.
export interface Girder { r: number; c1: number; c2: number; x1: number; x2: number; y: number }
/** `lo` is the index of the lower girder, `hi` the index of the upper one (index 0 is the top girder). */
export interface Ladder { x: number; c: number; lo: number; hi: number }
export type GeruestState = "beam" | "walk" | "climb" | "jump" | "hit" | "wait" | "cheer" | "beamout";
export interface Target { x: number; flag: boolean; ladder: Ladder | null; down: boolean }
export interface GeruestTux {
  id: number; g: number; x: number; y: number; dir: Dir; state: GeruestState; t: number; anim: number; lift: number;
  decided: Set<number>; target: Target | null; pending: "goal" | null; forced: boolean; noJump: boolean;
  ladder: Ladder | null; cd: number; dead: boolean; leaving: boolean; leaveT: number;
}
export type BarrelState = "roll" | "ladder" | "fall";
export interface Barrel { id: number; x: number; y: number; g: number; dir: Dir; state: BarrelState; anim: number; skip: Ladder | null; vy: number; pd: Dir; fromG: number; ladder: Ladder | null; dead: boolean }
export type RobotState = "idle" | "lift" | "throw" | "stomp";
export interface Robot { x: number; state: RobotState; t: number; next: number; nextStomp: number; hit: boolean }
export const SP = 36, CLIMB = 30, BSP = 70, MAX_TUXES = 3, MAX_BARRELS = 6, TOP_ROWS = 3, MAX_LADDERS = 3, MIN_LADDER_GAP = 4;
const CRUMB = ["#f0ebe0", "#ff4d6d", "#ffd23f"], SPARK = ["#4b4f8a", "#ffd23f", "#ff4d6d", "#f4efe6"], BARREL = ["#c8641e", "#5a2d12", "#ffd23f"];

/** The robot (48 pixels high) needs this much room above its girder. */
export const ROBOT_MIN_Y = 48;

export class GeruestSim extends SimBase {
  readonly id = "geruest" as const;
  girders: Girder[] = [];
  ladders: Ladder[] = [];
  tuxes: GeruestTux[] = [];
  barrels: Barrel[] = [];
  /** Null when no girder lies at least ROBOT_MIN_Y below the top edge (terminal too small): no robot, no barrel. */
  robot: Robot | null = null;
  /** Index of the robot girder: the goal of the Tuxes with the flag; the top girder if there is no robot. */
  goalG = 0;
  topRows = new Set<number>();
  flagX = 0;
  shake = 0;
  stats = { goal: 0, hit: 0, crumbled: 0 };
  spawnT = 1;
  private readonly margin: number;
  constructor(grid: Grid, rng: Rng, leaveAfter?: number) {
    super(grid, rng, leaveAfter);
    this.margin = Math.min(4, grid.cw / 2 - 0.5);
    for (const r of grid.textRows()) {
      const [c1, c2] = grid.range(r) as [number, number];
      this.girders.push({ r, c1, c2, x1: c1 * grid.cw, x2: (c2 + 1) * grid.cw, y: r * grid.ch + grid.ch * 0.8 });
    }
    if (this.girders.length < 2) return;
    this.makeLadders();
    this.topRows = new Set(this.girders.slice(0, TOP_ROWS).map(g => g.r));
    const rg = this.girders.findIndex(g => g.y >= ROBOT_MIN_Y);
    this.goalG = Math.max(0, rg);
    const top = this.girders[this.goalG];
    this.flagX = Math.min(top.x1 + 16, top.x2 - this.margin);
    if (rg >= 0) this.robot = { x: Math.max(4, top.x2 - 54), state: "idle", t: 0, next: 2, nextStomp: 6, hit: false };
  }
  /** At least two girders are needed for a ladder. */
  get usable(): boolean { return this.girders.length >= 2; }
  get done(): boolean { return this.closing && this.tuxes.length === 0 && this.barrels.length === 0; }
  private widen(g: Girder, c: number): void {
    if (c < g.c1) { g.c1 = c; g.x1 = c * this.grid.cw; }
    if (c > g.c2) { g.c2 = c; g.x2 = (c + 1) * this.grid.cw; }
  }
  /** 1 to 3 ladders between every row and the row above, on space columns of the lower row (any column if none). */
  private makeLadders(): void {
    const grid = this.grid;
    for (let i = 1; i < this.girders.length; i++) {
      const g = this.girders[i], u = this.girders[i - 1];
      let lo = Math.max(g.c1, u.c1), hi = Math.min(g.c2, u.c2);
      if (lo > hi) { const c = u.c2 < g.c1 ? u.c2 : u.c1; this.widen(g, c); lo = c; hi = c; }
      const cand: number[] = [];
      for (let c = lo + 1; c <= hi - 1; c++) if (!grid.hasText(g.r, c)) cand.push(c);
      if (!cand.length) for (let c = lo + 1; c <= hi - 1; c++) cand.push(c);
      if (!cand.length) for (let c = lo; c <= hi; c++) cand.push(c);
      const n = Math.min(cand.length, rint(this.rng, 1, MAX_LADDERS)), chosen: number[] = [];
      let guard = 0;
      while (chosen.length < n && guard++ < 60) { const c = pick(this.rng, cand); if (chosen.every(o => Math.abs(o - c) >= MIN_LADDER_GAP)) chosen.push(c); }
      if (!chosen.length) chosen.push(pick(this.rng, cand));
      for (const c of chosen) this.ladders.push({ x: c * grid.cw + grid.cw / 2, c, lo: i, hi: i - 1 });
    }
  }
  get start(): Girder { return this.girders[this.girders.length - 1]; }
  private startX(): number { const g = this.start; return Math.min(g.x1 + 14, g.x2 - this.margin); }
  private breakChar(r: number, c: number): void {
    if (!this.grid.hasChar(r, c) || !this.grid.destroy(r, c)) return;
    this.stats.crumbled++;
    for (let i = 0; i < 4; i++) this.parts.add(c * this.grid.cw + 4 + rnd(this.rng, -3, 3), r * this.grid.ch + 12, rnd(this.rng, -25, 25), rnd(this.rng, -40, 10), rnd(this.rng, 0.5, 1), pick(this.rng, CRUMB), 2, 500);
  }
  /** The stomp: 3 to 6 neighbouring characters in one of the top rows crumble. */
  private chunk(): void {
    const rows = [...this.topRows].filter(r => { for (let c = 0; c < this.grid.cols; c++) if (this.grid.hasChar(r, c)) return true; return false; });
    if (!rows.length) return;
    const r = pick(this.rng, rows), cs: number[] = [];
    for (let c = 0; c < this.grid.cols; c++) if (this.grid.hasChar(r, c)) cs.push(c);
    const c0 = pick(this.rng, cs), n = rint(this.rng, 3, 6);
    for (let k = 0; k < n; k++) this.breakChar(r, c0 + k);
  }
  spawn(): GeruestTux {
    const g = this.start;
    const t: GeruestTux = {
      id: this.nextId++, g: this.girders.length - 1, x: this.startX(), y: g.y, dir: 1, state: "beam", t: 0, anim: 0, lift: 0, decided: new Set(), target: null,
      pending: null, forced: false, noJump: false, ladder: null, cd: 0, dead: false, leaving: false, leaveT: rnd(this.rng, 0, 4),
    };
    this.tuxes.push(t);
    return t;
  }
  private target(ladder: Ladder, down: boolean): Target { return { x: ladder.x, flag: false, ladder, down }; }
  private retarget(t: GeruestTux): void {
    t.forced = false;
    const g = t.g;
    if (g === this.goalG) { t.target = { x: this.flagX, flag: true, ladder: null, down: false }; return; }
    const ups = this.ladders.filter(l => l.lo === g), downs = this.ladders.filter(l => l.hi === g);
    if (downs.length && (this.rng() < 0.18 || !ups.length)) t.target = this.target(pick(this.rng, downs), true);
    else if (ups.length) t.target = this.target(pick(this.rng, ups), false);
  }
  /** A short hop over a rolling barrel. */
  startJump(t: GeruestTux): void { t.state = "jump"; t.t = 0; }
  private startClimb(t: GeruestTux, ladder: Ladder, down: boolean): void { t.state = "climb"; t.ladder = ladder; t.cd = down ? 1 : -1; t.x = ladder.x; t.t = 0; t.target = null; }
  /** Puts the Tux on the robot girder close to the flag; it walks to the flag and cheers. */
  sendToGoal(t: GeruestTux): void {
    const top = this.girders[this.goalG];
    t.g = this.goalG; t.y = top.y; t.x = clamp(Math.min(top.x2 - 60, this.flagX + 60), top.x1 + this.margin, top.x2 - this.margin);
    t.dir = t.x > this.flagX ? -1 : 1; t.state = "walk"; t.t = 0; t.target = { x: this.flagX, flag: true, ladder: null, down: false }; t.forced = true;
  }
  private walk(t: GeruestTux, dt: number): void {
    const g = this.girders[t.g];
    if (t.target && Math.abs(t.target.x - t.x) > 2) t.dir = t.target.x > t.x ? 1 : -1;
    if (!t.noJump) {
      for (const b of this.barrels) {
        if (b.state === "roll" && b.g === t.g && !t.decided.has(b.id)) {
          const d = (b.x - t.x) * t.dir;
          if (d > 24 && d < 56 && b.dir * t.dir < 0) { t.decided.add(b.id); if (this.rng() < 0.55) { this.startJump(t); return; } }
        }
      }
    }
    t.x += t.dir * SP * dt;
    if (t.x < g.x1 + this.margin) { t.x = g.x1 + this.margin; t.dir = 1; }
    if (t.x > g.x2 - this.margin) { t.x = g.x2 - this.margin; t.dir = -1; }
    if (t.target && Math.abs(t.target.x - t.x) < 2) {
      if (t.target.flag) { t.state = "cheer"; t.t = 0; }
      else if (t.target.ladder) this.startClimb(t, t.target.ladder, t.target.down);
    } else if (!t.forced && this.rng() < 0.08 * dt) this.retarget(t);
  }
  private updateTux(t: GeruestTux, dt: number): void {
    t.t += dt; t.anim += dt;
    if (this.closing && (t.state === "walk" || t.state === "climb" || t.state === "jump" || t.state === "cheer")) {
      t.leaveT -= dt;
      if (t.leaveT <= 0) { t.state = "beamout"; t.t = 0; t.lift = 0; t.leaving = true; return; }
    }
    switch (t.state) {
      case "beam":
        if (t.t > 0.6) { t.state = "walk"; t.t = 0; if (t.pending === "goal") { t.pending = null; this.sendToGoal(t); } else this.retarget(t); }
        break;
      case "walk": this.walk(t, dt); break;
      case "climb": {
        t.y += t.cd * CLIMB * dt;
        const l = t.ladder as Ladder, tg = this.girders[t.cd < 0 ? l.hi : l.lo];
        if ((t.cd < 0 && t.y <= tg.y) || (t.cd > 0 && t.y >= tg.y)) {
          t.y = tg.y; t.g = t.cd < 0 ? l.hi : l.lo; t.state = "walk"; t.t = 0; t.dir = this.rng() < 0.5 ? 1 : -1; this.retarget(t);
        }
        break;
      }
      case "jump": {
        const u = t.t / 0.7, g = this.girders[t.g];
        t.lift = 4 * 26 * u * (1 - u);
        t.x = clamp(t.x + t.dir * SP * 1.25 * dt, g.x1 + this.margin, g.x2 - this.margin);
        if (u >= 1) { t.lift = 0; t.state = "walk"; t.t = 0; }
        break;
      }
      case "hit":
        if (t.t > 1.0) {
          for (let i = 0; i < 12; i++) this.parts.add(t.x, t.y - 14, rnd(this.rng, -50, 50), rnd(this.rng, -60, 10), 0.5, pick(this.rng, SPARK), 3, 200);
          t.state = "wait"; t.t = 0;
        }
        break;
      case "wait":
        if (t.t > 0.7) {
          const g = this.start;
          t.g = this.girders.length - 1; t.x = this.startX(); t.y = g.y; t.dir = 1; t.decided.clear(); t.lift = 0; t.target = null; t.forced = false; t.state = "beam"; t.t = 0;
        }
        break;
      case "cheer":
        if (this.rng() < 12 * dt) this.parts.add(t.x + rnd(this.rng, -10, 10), t.y - 34, rnd(this.rng, -30, 30), rnd(this.rng, -50, -10), 0.9, pick(this.rng, SPARK), 2, 120);
        if (t.t > 1.8) { t.state = "beamout"; t.t = 0; }
        break;
      case "beamout": if (t.t > 0.6) { t.dead = true; if (!t.leaving) this.stats.goal++; } break;
    }
  }
  /** A barrel on girder gi, rolling in direction dir. */
  addBarrel(x: number, gi: number, dir: Dir): Barrel {
    const b: Barrel = { id: this.nextId++, x, y: this.girders[gi].y - 8, g: gi, dir, state: "roll", anim: 0, skip: null, vy: 0, pd: dir, fromG: gi, ladder: null, dead: false };
    this.barrels.push(b);
    return b;
  }
  private updateBarrel(b: Barrel, dt: number): void {
    b.anim += dt;
    if (b.state === "roll") {
      const g = this.girders[b.g], nx = b.x + b.dir * BSP * dt;
      if (this.grid.colOf(nx) !== this.grid.colOf(b.x) && this.topRows.has(g.r) && this.rng() < 0.22) this.breakChar(g.r, this.grid.colOf(nx));
      b.x = nx;
      for (const l of this.ladders) {
        if (l.hi === b.g && l !== b.skip && Math.abs(l.x - b.x) < 3) {
          b.skip = l;
          if (this.rng() < 0.35) { b.state = "ladder"; b.ladder = l; b.x = l.x; break; }
        }
      }
      if (b.state === "roll" && (b.x < g.x1 - 3 || b.x > g.x2 + 3)) { b.state = "fall"; b.vy = 0; b.pd = b.dir; b.fromG = b.g; }
    } else if (b.state === "ladder") {
      const l = b.ladder as Ladder, lg = this.girders[l.lo];
      b.y += 60 * dt;
      if (b.y >= lg.y - 8) { b.y = lg.y - 8; b.g = l.lo; b.state = "roll"; b.dir = this.rng() < 0.5 ? -1 : 1; b.skip = l; }
    } else {
      b.vy += 650 * dt;
      const ny = b.y + b.vy * dt;
      let best = -1;
      for (let j = 0; j < this.girders.length; j++) {
        const g = this.girders[j], cy = g.y - 8;
        if (j === b.fromG || cy < b.y || cy > ny || b.x < g.x1 - 2 || b.x > g.x2 + 2) continue;
        if (best < 0 || g.y < this.girders[best].y) best = j;
      }
      if (best >= 0) { b.g = best; b.y = this.girders[best].y - 8; b.state = "roll"; b.dir = flip(b.pd); b.skip = null; }
      else { b.y = ny; if (b.y > this.grid.height + 20) b.dead = true; }
    }
  }
  private hits(): void {
    for (const t of this.tuxes) {
      if (t.state !== "walk" && t.state !== "climb" && t.state !== "jump") continue;
      const ty = t.y - t.lift;
      for (const b of this.barrels) {
        if (!b.dead && Math.abs(b.x - t.x) < 11 && b.y + 8 > ty - 28 && b.y - 8 < ty) {
          b.dead = true; t.state = "hit"; t.t = 0; t.lift = 0; this.stats.hit++;
          for (let i = 0; i < 8; i++) this.parts.add(b.x, b.y, rnd(this.rng, -70, 70), rnd(this.rng, -80, 0), 0.5, pick(this.rng, BARREL), 3, 300);
          break;
        }
      }
    }
  }
  private updateRobot(r: Robot, dt: number): void {
    r.t += dt;
    switch (r.state) {
      case "idle":
        if (this.closing) break;
        r.next -= dt; r.nextStomp -= dt;
        if (r.nextStomp <= 0) { r.state = "stomp"; r.t = 0; r.hit = false; }
        else if (r.next <= 0 && this.barrels.length < MAX_BARRELS) { r.state = "lift"; r.t = 0; }
        break;
      case "lift":
        if (r.t > 0.5) { r.state = "throw"; r.t = 0; this.addBarrel(r.x - 4, this.goalG, -1); }
        break;
      case "throw":
        if (r.t > 0.3) { r.state = "idle"; r.next = rnd(this.rng, 2.4, 5); }
        break;
      case "stomp":
        if (!r.hit && r.t > 0.35) { r.hit = true; this.shake = 0.45; this.chunk(); }
        if (r.t > 0.65) { r.state = "idle"; r.nextStomp = rnd(this.rng, 8, 13); }
        break;
    }
  }
  protected step(dt: number): void {
    if (!this.usable) return;
    if (this.shake > 0) this.shake -= dt;
    if (!this.closing) {
      this.spawnT -= dt;
      if (this.spawnT <= 0 && this.tuxes.length < MAX_TUXES) { this.spawn(); this.spawnT = rnd(this.rng, 4, 7); }
    }
    for (const t of this.tuxes) this.updateTux(t, dt);
    for (const b of this.barrels) this.updateBarrel(b, dt);
    this.hits();
    if (this.robot) this.updateRobot(this.robot, dt);
    this.tuxes = this.tuxes.filter(t => !t.dead);
    this.barrels = this.barrels.filter(b => !b.dead);
  }
}
