import { clamp, flip, pick, rint, rnd, SimBase, Surfaces, type Dir, type Grid, type Plank, type Rng } from "./retroGrid";
// Retro Hüpfer: Tuxes drop out of a pipe at the top, zigzag over the text rows and punch down through them with a
// crouched jump. ?-blocks over word gaps hold coins and items. The goal flag and the exit pipe sit bottom left.
export type HuepferState = "enter" | "fall" | "walk" | "hop" | "crouch" | "jumpup" | "slam" | "bumpjump" | "soar" | "eat" | "cheer" | "exit" | "vanish";
export type BlockType = "coin" | "multi" | "fish" | "star" | "feather" | "empty";
export type ItemKind = "coin" | "fish" | "star" | "feather";
export type HuepferRequest = "duck" | `block:${BlockType}`;
export interface Block { id: number; x: number; y: number; row: number; type: BlockType; state: "fresh" | "empty"; left: number; bump: number; age: number; gone: boolean }
export interface Item { id: number; kind: ItemKind; x: number; y: number; by: number; vx: number; vy: number; state: "emerge" | "free" | "rest"; t: number; gone: boolean; life: number; floorY: number }
export interface HuepferTux {
  id: number; x: number; y: number; vy: number; dir: Dir; state: HuepferState; t: number; anim: number; row: number; hvx: number;
  pending: HuepferRequest | null; goalBlock: Block | null; goalItem: Item | null; big: number; star: number; cool: number; hit: boolean; done: boolean;
  dead: boolean; leaveT: number; baseY: number;
}
export const WALK = 42, HG = 900, SG = 520, PIPE_R = 50, POLE_X = 100, MAX_TUXES = 5, MAX_BLOCKS = 4, TOP_ROWS = 3, ENTRY_Y = 18;
/** Chance that a Tux changes direction after falling down into the next row (zigzag). */
export const TURN_AFTER_FALL = 0.7;
export const RAINBOW = ["#ff4d4d", "#ffd23f", "#4cd964", "#5cc8ff", "#e87cff"];
const BLOCK_TYPES: BlockType[] = ["coin", "coin", "coin", "multi", "fish", "star", "feather", "empty"];
const GOLD = ["#fcc419", "#fff0a0", "#ffffff"], BRICK = ["#b5522a", "#5a2a0c", "#ff8a5b"], CHEER = ["#fcc419", "#ff6b6b", "#5cc8ff", "#ffffff"];
const AIR_STATES: HuepferState[] = ["walk", "hop", "fall", "jumpup", "slam", "bumpjump", "soar"];

export class HuepferSim extends SimBase {
  readonly id = "huepfer" as const;
  tuxes: HuepferTux[] = [];
  blocks: Block[] = [];
  items: Item[] = [];
  pipes: { x: number; t: number }[] = [];
  flashes: { r: number; c: number; t: number }[] = [];
  readonly topRows: Set<number>;
  stats = { saved: 0, coins: 0, items: 0, crumbled: 0, goal: 0 };
  flagLv = 0;
  flagHold = 0;
  spawnT = 1;
  private readonly surfaces: Surfaces;
  constructor(grid: Grid, readonly groundRow: number, rng: Rng, leaveAfter?: number) {
    super(grid, rng, leaveAfter);
    this.topRows = new Set(grid.textRows().slice(0, TOP_ROWS));
    this.surfaces = new Surfaces(grid, groundRow, true, () => this.blocks.filter((b): boolean => b.state === "empty").map((b): Plank => ({ x1: b.x - 8, x2: b.x + 8, y: b.y - 16 })));
  }
  get done(): boolean { return this.closing && this.tuxes.length === 0; }
  /** Text rows covered by the drawn block over row r (16 pixels, from floorY - 60 to floorY - 44). */
  blockRows(r: number): [number, number] {
    const fy = this.grid.floorY(r);
    return [Math.floor((fy - 60) / this.grid.ch), Math.ceil((fy - 44) / this.grid.ch) - 1];
  }
  /** Blocks may only stand over text rows; the drawn block must lie fully on screen and outside the top three text rows. */
  blockRowOk(r: number): boolean {
    if (r < 0 || r >= this.groundRow || this.grid.range(r) === null) return false;
    const [r0, r1] = this.blockRows(r);
    if (r0 < 0) return false;
    for (let k = r0; k <= Math.max(r, r1); k++) if (this.topRows.has(k)) return false;
    return true;
  }
  private sparkle(x: number, y: number, cols: string[] = GOLD): void {
    for (let i = 0; i < 8; i++) this.parts.add(x, y, rnd(this.rng, -50, 50), rnd(this.rng, -70, 10), 0.5, pick(this.rng, cols), 2, 150);
  }
  spawn(o: { x?: number; pending?: HuepferRequest } = {}): HuepferTux {
    const g = this.grid;
    let x = o.x;
    if (x === undefined) {
      const lo = Math.floor(g.cols * 30 / 80), hi = Math.max(lo, Math.min(g.cols - 3, Math.floor(g.cols * 74 / 80)));
      x = (rint(this.rng, lo, hi) + 0.5) * g.cw;
      for (let i = 0; i < 20 && this.surfaces.firstRow(g.colOf(x)) >= this.groundRow; i++) x = (rint(this.rng, lo, hi) + 0.5) * g.cw;
    }
    const t: HuepferTux = {
      id: this.nextId++, x, y: ENTRY_Y, vy: 0, dir: this.rng() < 0.5 ? -1 : 1, state: "enter", t: 0, anim: 0, row: -2, hvx: 0, pending: o.pending ?? null,
      goalBlock: null, goalItem: null, big: 0, star: 0, cool: 0, hit: false, done: false, dead: false, leaveT: rnd(this.rng, 0, 4), baseY: ENTRY_Y,
    };
    this.tuxes.push(t); this.pipes.push({ x, t: 0 });
    return t;
  }
  /** Centres of the word gaps (floor over spaces) of a row. */
  private gapsOf(row: number): number[] {
    const out: number[] = [];
    let c = 0;
    while (c < this.grid.cols) {
      if (this.grid.bridged(row, c)) {
        let e = c;
        while (e + 1 < this.grid.cols && this.grid.bridged(row, e + 1)) e++;
        out.push((c + e + 1) / 2 * this.grid.cw); c = e + 1;
      } else c++;
    }
    return out;
  }
  /** A block over a word gap of the row; never in the top three text rows, at most four at a time. */
  placeBlock(row: number, type: BlockType, tux?: HuepferTux): Block | null {
    if (!this.blockRowOk(row) || this.blocks.length >= MAX_BLOCKS) return null;
    const xs = this.gapsOf(row).filter(x => !this.blocks.some(b => b.row === row && Math.abs(b.x - x) < 36));
    if (!xs.length) return null;
    if (tux) xs.sort((a, b) => Math.abs(a - tux.x) - Math.abs(b - tux.x));
    const x = tux ? xs[Math.min(xs.length - 1, rint(this.rng, 0, 1))] : pick(this.rng, xs);
    const b: Block = { id: this.nextId++, x, y: this.grid.floorY(row) - 44, row, type, state: type === "empty" ? "empty" : "fresh", left: type === "multi" ? 4 : 1, bump: 0, age: 0, gone: false };
    this.blocks.push(b); this.sparkle(x, b.y - 8);
    if (tux) tux.goalBlock = b;
    return b;
  }
  startDuck(t: HuepferTux): boolean {
    if (t.row < 0 || t.row >= this.groundRow) return false;
    t.state = "crouch"; t.t = 0; t.goalBlock = null; t.goalItem = null;
    return true;
  }
  startHop(t: HuepferTux, across: boolean): void { t.state = "hop"; t.vy = -235; t.hvx = t.dir * WALK * (t.star > 0 ? 2 : 1) * (across ? 1.9 : 1.1); t.t = 0; t.baseY = t.y; }
  private gapAhead(t: HuepferTux): number {
    for (let k = 1; k <= 5; k++) if (this.surfaces.solidAt(t.row, this.grid.colOf(t.x) + t.dir * k)) return k;
    return 99;
  }
  private newItem(kind: ItemKind, b: Block, floorY: number): Item {
    return { id: this.nextId++, kind, x: b.x, y: b.y - 6, by: b.y, vx: 0, vy: 0, state: "emerge", t: 0, gone: false, life: 0, floorY };
  }
  private bump(b: Block, t: HuepferTux): void {
    b.bump = 0.2;
    if (b.state === "empty") {
      t.goalBlock = null;
      for (let i = 0; i < 3; i++) this.parts.add(b.x + rnd(this.rng, -6, 6), b.y, rnd(this.rng, -20, 20), rnd(this.rng, -30, 0), 0.4, "#c68a4e", 2, 200);
      return;
    }
    if (b.type === "coin" || b.type === "multi") {
      const c = this.newItem("coin", b, t.baseY);
      c.y = b.y - 16; c.vy = -260; this.items.push(c); this.stats.coins++; b.left--;
      if (b.left <= 0) { b.state = "empty"; t.goalBlock = null; } else t.cool = 0.35;
    } else {
      // The item drops to the level of the Tux that hit the block and lands a little beside it.
      const it = this.newItem(b.type as ItemKind, b, t.baseY);
      this.items.push(it); b.state = "empty"; t.goalBlock = null; t.goalItem = it;
    }
  }
  private brickBurst(r: number, c: number): void {
    if (!this.grid.destroy(r, c)) return;
    this.stats.crumbled++; this.flashes.push({ r, c, t: 0 });
    for (let i = 0; i < 4; i++) this.parts.add(c * this.grid.cw + 4, this.grid.floorY(r) - 4, rnd(this.rng, -80, 80), rnd(this.rng, -170, -60), 1.1, pick(this.rng, BRICK), 3, 700);
  }
  private impact(t: HuepferTux, s: { y: number; row: number }): void {
    t.y = s.y; t.row = s.row;
    if (s.row === this.groundRow) { this.sparkle(t.x, t.y - 2, ["#c68a4e", "#9a5f2a"]); t.state = "walk"; t.t = 0; return; }
    const c = this.grid.colOf(t.x);
    for (let k = -1; k <= 1; k++) this.brickBurst(s.row, c + k);
    t.state = "fall"; t.vy = 60; t.t = 0;
  }
  private land(t: HuepferTux, s: { y: number; row: number }): void {
    const was: HuepferState = t.state;
    t.y = s.y; t.row = s.row;
    if (was === "slam") { this.impact(t, s); return; }
    t.state = "walk"; t.t = 0; t.vy = 0;
    if (was === "fall" && this.rng() < TURN_AFTER_FALL) t.dir = flip(t.dir);
    if (was === "fall" && s.row < this.groundRow && this.rng() < 0.3) this.placeBlock(s.row, pick(this.rng, BLOCK_TYPES), t);
  }
  private air(t: HuepferTux, dt: number): void {
    t.vy += (t.state === "soar" ? SG : HG) * dt;
    if (t.state === "hop" || t.state === "soar") t.x = clamp(t.x + t.hvx * dt, 12, this.grid.width - 12);
    if (t.state === "bumpjump" && !t.hit && t.vy < 0) {
      const b = t.goalBlock;
      if (b && b.state !== "empty" && t.y - 30 <= b.y) { t.hit = true; this.bump(b, t); t.vy = 80; }
    }
    if (t.state === "jumpup" && t.vy >= 0) { t.state = "slam"; t.vy = 480; t.t = 0; }
    const ny = t.y + t.vy * dt;
    if (t.vy > 0) {
      // A hop lands on its starting level or lower, never on a floor above it: the Tuxes zigzag downwards.
      const s = this.surfaces.landing(t.x, t.state === "hop" ? Math.max(t.y, t.baseY - 1) : t.y, ny);
      if (s) { this.land(t, s); return; }
    }
    t.y = ny;
    if (t.y > this.grid.height + 60) t.dead = true;
  }
  private walk(t: HuepferTux, dt: number): void {
    // Wait below the block until the item has landed beside the Tux, then walk there.
    const wait = t.goalItem;
    if (wait && !wait.gone && wait.state !== "rest") return;
    t.anim += dt;
    if (t.pending && t.t > 0.3) {
      const p = t.pending;
      if (p === "duck") {
        if (t.row >= 0 && t.row < this.groundRow) { t.pending = null; if (this.startDuck(t)) return; }
      } else if (this.blockRowOk(t.row)) { t.pending = null; this.placeBlock(t.row, p.slice(6) as BlockType, t); }
    }
    if (t.row === this.groundRow && !t.done && t.x <= POLE_X + 20) {
      t.done = true; t.state = "cheer"; t.t = 0; t.x = POLE_X + 20; t.dir = -1; this.flagHold = 5; this.stats.goal++;
      return;
    }
    const spd = WALK * (t.star > 0 ? 2 : 1) * (t.big > 0 ? 0.9 : 1);
    let tx: number | null = null;
    const gi = t.goalItem;
    if (gi && !gi.gone && !(gi.state === "rest" && Math.abs(gi.y - t.y) > 8)) tx = gi.x; else t.goalItem = null;
    if (tx === null) {
      const gb = t.goalBlock;
      if (gb && !gb.gone && gb.row === t.row) tx = gb.x; else t.goalBlock = null;
    }
    if (tx !== null) {
      if (Math.abs(tx - t.x) > 3) t.dir = tx > t.x ? 1 : -1;
      else if (t.goalBlock && t.cool <= 0 && tx === t.goalBlock.x) {
        t.state = "bumpjump"; t.vy = t.goalBlock.state === "empty" ? -400 : -330; t.t = 0; t.hit = false; t.x = tx; t.baseY = t.y;
        return;
      }
    } else if (t.row === this.groundRow) t.dir = -1;
    if (tx === null && t.row >= 0 && t.row < this.groundRow && t.t > 1.0 && !this.closing && this.rng() < 0.09 * dt) { if (this.startDuck(t)) return; }
    // No random hops on the lowest row: a hop would land on the text row just above and leave the way to the flag.
    if (tx === null && t.row !== this.groundRow && this.rng() < (t.star > 0 ? 0.7 : 0.3) * dt) { this.startHop(t, false); return; }
    const nx = t.x + t.dir * spd * dt;
    if (nx < 14 || nx > this.grid.width - 14) { t.dir = flip(t.dir); return; }
    const g = this.surfaces.nearest(nx, t.y, 6);
    if (!g) {
      if (this.gapAhead(t) <= 4 && this.rng() < 0.75) { this.startHop(t, true); return; }
      let below = false;
      for (let r = t.row + 1; r < this.groundRow; r++) if (this.grid.solid(r, this.grid.colOf(nx))) { below = true; break; }
      if (!below && this.rng() < 0.5) { t.dir = flip(t.dir); return; }
      t.x = nx; t.state = "fall"; t.vy = 0; t.t = 0; t.row = -2;
      return;
    }
    t.x = nx; t.y = g.y; t.row = g.row;
    if (t.row === this.groundRow && t.x < PIPE_R + 4) { t.state = "exit"; t.t = 0; t.dir = -1; }
  }
  private collect(t: HuepferTux, it: Item): void {
    it.gone = true; this.stats.items++;
    if (it.kind === "fish") { t.big = 7; if (t.state === "walk") { t.state = "eat"; t.t = 0; } this.sparkle(t.x, t.y - 20, ["#ff8a5b", "#ffd0b0"]); }
    else if (it.kind === "star") { t.star = 6; this.sparkle(t.x, t.y - 20, RAINBOW); }
    else if (it.kind === "feather") { t.state = "soar"; t.vy = -340; t.hvx = t.dir * 30; t.t = 0; this.sparkle(t.x, t.y - 20, ["#f1f5ee", "#9fd8ff"]); }
  }
  private updateTux(t: HuepferTux, dt: number): void {
    t.t += dt;
    if (t.cool > 0) t.cool -= dt;
    t.big = Math.max(0, t.big - dt); t.star = Math.max(0, t.star - dt);
    if (this.closing && t.state !== "exit" && t.state !== "vanish" && t.state !== "enter") {
      t.leaveT -= dt;
      if (t.leaveT <= 0) { this.sparkle(t.x, t.y - 14, CHEER); t.state = "vanish"; t.t = 0; return; }
    }
    if (t.star > 0 && this.rng() < 20 * dt) this.parts.add(t.x + rnd(this.rng, -10, 10), t.y - rnd(this.rng, 4, 30), rnd(this.rng, -15, 15), rnd(this.rng, -30, 0), 0.4, pick(this.rng, RAINBOW), 2, 0);
    switch (t.state) {
      case "enter": if (t.t > 0.4) { t.state = "fall"; t.t = 0; } break;
      case "walk": this.walk(t, dt); break;
      case "eat": t.anim += dt; if (t.t > 0.7) { t.state = "walk"; t.t = 0; } break;
      case "cheer":
        if (this.rng() < 14 * dt) this.parts.add(t.x + rnd(this.rng, -10, 10), t.y - 34, rnd(this.rng, -40, 40), rnd(this.rng, -70, -20), 0.9, pick(this.rng, CHEER), 2, 150);
        if (t.t > 1.6) { t.state = "walk"; t.t = 0; t.dir = -1; }
        break;
      case "crouch": if (t.t > 0.45) { t.state = "jumpup"; t.vy = -330; t.t = 0; this.sparkle(t.x, t.y - 2, ["#c68a4e", "#fff4e0"]); } break;
      case "exit": t.x -= WALK * dt; if (t.x < PIPE_R - 34) { t.dead = true; this.stats.saved++; } break;
      case "vanish": if (t.t > 0.3) t.dead = true; break;
      default: this.air(t, dt);
    }
  }
  /** Where the item will come down: a little beside the Tux that hit the block, on solid floor of its level. */
  private dropOffset(it: Item): number {
    const g = this.grid, row = Math.round((it.floorY - g.ch * 0.3) / g.ch);
    const side = this.rng() < 0.5 ? -1 : 1;
    for (const s of [side, -side]) {
      const x = it.x + s * 24;
      if (x > 12 && x < g.width - 12 && this.surfaces.solidAt(row, g.colOf(x)) && Math.abs(g.floorY(row) - it.floorY) < 1) return s * 24;
    }
    return 0;
  }
  private updateItem(it: Item, dt: number): void {
    it.t += dt;
    if (it.kind === "coin") {
      it.vy += 800 * dt; it.y += it.vy * dt;
      if (it.t > 0.7) { it.gone = true; this.sparkle(it.x, it.y - 8); }
      return;
    }
    if (it.state === "emerge") {
      const u = Math.min(1, it.t / 0.4);
      it.y = it.by - 16 + 10 - 10 * u;
      if (u >= 1) {
        it.state = "free"; it.vy = -140;
        // Fall time to the Tux's level, so that the item lands exactly beside it.
        const drop = Math.max(0, it.floorY - it.y), fall = (140 + Math.sqrt(140 * 140 + 2 * HG * drop)) / HG;
        it.vx = this.dropOffset(it) / fall;
      }
      return;
    }
    if (it.state === "rest") {
      it.life -= dt;
      if (it.life <= 0) it.gone = true;
      else if (!this.surfaces.nearest(it.x, it.y, 2)) { it.state = "free"; it.vy = 0; it.floorY = it.y; }
      return;
    }
    it.vy += HG * dt;
    const ny = it.y + it.vy * dt;
    it.x = clamp(it.x + it.vx * dt, 8, this.grid.width - 8);
    if (it.vy > 0) {
      // Floors above the Tux's level (text rows over it) are ignored: the item keeps falling to that level.
      const s = this.surfaces.landing(it.x, Math.max(it.y, it.floorY - 1), ny);
      if (s) { it.y = s.y; it.state = "rest"; it.vx = 0; it.life = 10; return; }
    }
    it.y = ny;
    if (it.y > this.grid.height + 30) it.gone = true;
  }
  protected step(dt: number): void {
    if (this.flagHold > 0) { this.flagHold -= dt; this.flagLv = Math.min(1, this.flagLv + dt / 1.2); } else this.flagLv = Math.max(0, this.flagLv - dt / 2);
    for (const p of this.pipes) p.t += dt;
    this.pipes = this.pipes.filter(p => p.t < 1.5);
    for (const f of this.flashes) f.t += dt;
    this.flashes = this.flashes.filter(f => f.t < 0.15);
    if (!this.closing) {
      this.spawnT -= dt;
      if (this.spawnT <= 0 && this.tuxes.length < MAX_TUXES) { this.spawn(); this.spawnT = rnd(this.rng, 2.5, 5); }
    }
    for (const t of this.tuxes) this.updateTux(t, dt);
    for (const it of this.items) this.updateItem(it, dt);
    for (const it of this.items) {
      if (it.gone || it.kind === "coin" || it.state !== "rest") continue;
      for (const t of this.tuxes) {
        if (!AIR_STATES.includes(t.state)) continue;
        if (Math.abs(it.x - t.x) < 12 && it.y >= t.y - 30 && it.y - 16 <= t.y) { this.collect(t, it); break; }
      }
    }
    for (const b of this.blocks) { b.age += dt; if (b.bump > 0) b.bump -= dt; if (b.age > 30) b.gone = true; }
    this.tuxes = this.tuxes.filter(t => !t.dead);
    this.items = this.items.filter(i => !i.gone);
    this.blocks = this.blocks.filter(b => !b.gone);
  }
}
