import { hitBlock, type ActionId, type Block, type BlockItem, type Rng } from "./actions";
import { between, clamp, ease, sgn, stepParticles, type Layout, type Particle, type Scene } from "./scene";
// Retro Hüpfer: a Tux bumps ?-blocks from below. Coin, fish, star, feather, coin series, empty block.
// Ported from the approved preview (virtual pixels).
export type HupSprite = "stand" | "sideA" | "sideB" | "jump" | "eatA" | "eatB";
export const BLOCK_WIDTH = 24, GRAVITY = 600;
/** Body colours the Tux flashes through while the star is active. */
export const STAR_TINTS = ["#ffffff", "#ffd23f", "#ff4d6d", "#4cd9ff"];
export const STAR_TIME = 4.5, STAR_SPEED = 1.8, EAT_SCALE = 1.5;
export type Step =
  | { t: "walk"; x: number; sp: number } | { t: "jump"; vy: number; vx?: number; go?: boolean } | { t: "jumps"; n: number; k?: number; pause?: number }
  | { t: "wait"; w: number } | { t: "chase"; kind: BlockItem; sp: number; star?: boolean } | { t: "eat" } | { t: "launch"; go?: boolean } | { t: "leave" };
export interface HupActor {
  x: number; y: number; dir: number; vy: number; vx: number; air: boolean; mode: "walk" | "eat"; t: number; dead: boolean; scale: number; boost: number; bigT: number | null;
  script: Step[]; si: number; st: number; spr: HupSprite; walking: boolean; tint: string | null;
}
export interface Item { kind: BlockItem; x: number; y: number; vx: number; vy: number; t: number; alive: boolean; a: number }
export class JumperScene implements Scene {
  blocks: Block[]; actors: HupActor[] = []; items: Item[] = []; parts: Particle[] = []; blocksAlpha = 0; time = 0;
  readonly ledgeTop: number; readonly ledgeBottom: number; readonly ledgeX: number;
  private finished: () => boolean = () => true;
  constructor(readonly action: ActionId, readonly layout: Layout, private rng: Rng) {
    const gy = layout.gy;
    this.ledgeTop = gy - 78; this.ledgeBottom = gy - 54; this.ledgeX = Math.round(layout.width * .39);
    const x0 = this.ledgeX;
    // Blocks 1 and 3 are ?-blocks, the others bricks; the action decides what they hold.
    this.blocks = [0, 1, 2, 3, 4].map(i => ({ x: x0 + BLOCK_WIDTH * i, brick: i !== 1 && i !== 3, item: "coin" as BlockItem, left: 0, bump: 1 }));
    const A = this.blocks[1], B = this.blocks[3];
    B.left = 1; // the second ?-block stays full and untouched unless the action says otherwise
    const run = (x: number, script: Step[]) => { const a = this.add(x, script); this.finished = () => a.dead && !this.items.some(i => i.alive); };
    if (action === "coinSeries") {
      B.item = "coin"; B.left = 5;
      run(x0 - 50, [{ t: "walk", x: B.x + 12, sp: 80 }, { t: "jumps", n: 6 }, { t: "wait", w: .6 }, { t: "leave" }]);
    } else if (action === "emptyBlock") {
      A.left = 0;
      run(x0 - 100, [{ t: "walk", x: A.x + 12, sp: 80 }, { t: "jump", vy: -260 }, { t: "wait", w: .5 }, { t: "walk", x: x0 - 35, sp: 80 }, { t: "jump", vy: -335, vx: 90 }, { t: "walk", x: x0 + 122, sp: 45 }, { t: "leave" }]);
    } else {
      const kind = action as BlockItem;
      A.item = kind; A.left = 1;
      const script: Step[] = [{ t: "walk", x: A.x + 12, sp: 80 }, { t: "jump", vy: -260 }, { t: "wait", w: .4 }];
      if (kind === "coin") script.push({ t: "leave" });
      if (kind === "fish") script.push({ t: "chase", kind, sp: 80 }, { t: "eat" }, { t: "leave" });
      if (kind === "star") script.push({ t: "chase", kind, sp: 80, star: true }, { t: "leave" });
      if (kind === "feather") script.push({ t: "chase", kind, sp: 70 }, { t: "launch" }, { t: "leave" });
      run(x0 - 100, script);
    }
  }
  get done(): boolean { return this.finished() && this.blocksAlpha <= 0; }
  private add(x: number, script: Step[]): HupActor {
    const a: HupActor = { x, y: this.layout.gy, dir: 1, vy: 0, vx: 0, air: false, mode: "walk", t: between(this.rng, 0, 3), dead: false, scale: 1, boost: 0, bigT: null, script, si: 0, st: 0, spr: "stand", walking: false, tint: null };
    this.actors.push(a); return a;
  }
  private onLedge(x: number): boolean { return x >= this.ledgeX && x <= this.ledgeX + BLOCK_WIDTH * this.blocks.length; }
  private blockAt(x: number): Block | undefined { return this.blocks.find(b => x >= b.x && x < b.x + BLOCK_WIDTH); }
  private support(x: number, y: number): number { return this.onLedge(x) && y <= this.ledgeTop + 1 ? this.ledgeTop : this.layout.gy; }
  private burst(x: number, y: number, c: string): void {
    for (let i = 0; i < 10; i++) this.parts.push({ x, y, vx: between(this.rng, -70, 70), vy: between(this.rng, -110, -20), life: .6, c });
  }
  private spawn(kind: BlockItem, b: Block): void {
    const it: Item = { kind, x: b.x + BLOCK_WIDTH / 2, y: this.ledgeTop - 6, vx: 0, vy: 0, t: 0, alive: true, a: 1 };
    if (kind === "fish") { it.vx = 45; it.vy = -200; } else if (kind === "star") { it.vx = 40; it.vy = -220; } else if (kind === "coin") it.y = this.ledgeTop - 8;
    this.items.push(it);
  }
  private bump(b: Block | undefined): void {
    if (!b) return;
    const item = hitBlock(b);
    if (item) this.spawn(item, b);
  }
  private physics(a: HupActor, dt: number): void {
    const k = a.scale || 1, prevY = a.y, prevHead = a.y - 32 * k;
    if (!a.air && a.y < this.support(a.x, a.y) - .5) { a.air = true; a.vy = 0; }
    if (!a.air) return;
    a.vy += GRAVITY * dt; a.y += a.vy * dt; a.x += a.vx * dt;
    if (a.vy < 0 && this.onLedge(a.x) && prevHead >= this.ledgeBottom && a.y - 32 * k < this.ledgeBottom) { a.y = this.ledgeBottom + 32 * k; a.vy = 90; this.bump(this.blockAt(a.x)); }
    const sup = this.support(a.x, prevY);
    if (a.vy >= 0 && a.y >= sup) { a.y = sup; a.vy = 0; a.vx = 0; a.air = false; }
  }
  private runScript(a: HupActor, dt: number): void {
    const s = a.script[a.si]; if (!s) return;
    const next = () => { a.si++; a.st = 0; };
    const mul = a.boost > 0 ? STAR_SPEED : 1;
    a.st += dt;
    switch (s.t) {
      case "walk": { const sp = s.sp * mul, dx = s.x - a.x; if (Math.abs(dx) <= sp * dt + .5) { a.x = s.x; next(); } else { a.dir = sgn(dx); a.x += a.dir * sp * dt; a.walking = true; } break; }
      case "jump": if (!s.go) { s.go = true; a.vy = s.vy; a.vx = s.vx ?? 0; if (s.vx) a.dir = sgn(s.vx); a.air = true; } else if (!a.air) next(); break;
      case "jumps":
        if (!a.air) { s.pause = (s.pause ?? 0) - dt; if (s.pause <= 0) { s.k = s.k ?? 0; if (s.k >= s.n) next(); else { s.k++; a.vy = -260; a.vx = 0; a.air = true; s.pause = .1; } } }
        break;
      case "wait": if (a.st >= s.w) next(); break;
      case "chase": {
        const it = this.items.find(i => i.kind === s.kind && i.alive);
        if (!it) { next(); break; }
        const dx = it.x - a.x; if (Math.abs(dx) > 3) { a.dir = sgn(dx); a.x += a.dir * s.sp * mul * dt; a.walking = true; }
        if (Math.abs(dx) < 14 && it.y >= this.layout.gy - 30) {
          it.alive = false;
          if (s.star) { a.boost = STAR_TIME; this.burst(a.x, a.y - 16, "#ffd23f"); }
          next();
        }
        break;
      }
      case "eat": a.mode = "eat"; if (a.st >= 1) { a.mode = "walk"; a.bigT = 0; next(); } break;
      case "launch": if (!s.go) { s.go = true; a.vy = -390; a.vx = 45; a.air = true; this.burst(a.x, a.y, "#9fd8ff"); } else if (!a.air) next(); break;
      case "leave": a.dir = 1; a.x += 70 * mul * dt; a.walking = true; if (a.x > this.layout.width + 50) a.dead = true; break;
    }
  }
  private stepItem(it: Item, dt: number): void {
    const gy = this.layout.gy;
    it.t += dt;
    if (it.kind === "coin") { const p = it.t; it.y = this.ledgeTop - 10 - 38 * 4 * p * (1 - p); it.a = p < .6 ? 1 : clamp(1 - (p - .6) / .4, 0, 1); if (p >= 1) it.alive = false; return; }
    if (it.kind === "feather") {
      if (it.t < .35) it.y -= 140 * dt; else if (it.y < gy - 8) { it.y = Math.min(gy - 8, it.y + 26 * dt); it.x += (26 + 16 * Math.cos(it.t * 3)) * dt; }
      if (it.t > 16) it.alive = false;
      return;
    }
    it.vy += GRAVITY * dt; it.x += it.vx * dt; it.y += it.vy * dt;
    if (it.y >= gy - 8) { it.y = gy - 8; if (it.kind === "star") it.vy = -Math.max(150, Math.abs(it.vy) * .85); else { it.vy = 0; it.vx = 0; } }
    if (it.x > this.layout.width - 12) { it.x = this.layout.width - 12; it.vx = -Math.abs(it.vx); }
    if (it.t > 14) it.alive = false;
  }
  private stepActor(a: HupActor, dt: number): void {
    a.t += dt; a.walking = false;
    this.runScript(a, dt);
    this.physics(a, dt);
    if (a.boost > 0) { a.boost -= dt; a.tint = a.boost > 0 ? STAR_TINTS[Math.floor(a.t * 11) % STAR_TINTS.length] : null; }
    if (a.bigT !== null) {
      a.bigT += dt; const b = a.bigT;
      a.scale = b < .4 ? 1 + (EAT_SCALE - 1) * ease(b / .4) : b < 2.6 ? EAT_SCALE : b < 3.2 ? EAT_SCALE - (EAT_SCALE - 1) * ((b - 2.6) / .6) : 1;
      if (b >= 3.2) { a.bigT = null; a.scale = 1; }
    }
    a.spr = a.air ? "jump" : a.mode === "eat" ? (Math.floor(a.t * 6) % 2 ? "eatA" : "eatB") : a.walking ? (Math.floor(a.t * (a.boost > 0 ? 11 : 6)) % 2 ? "sideA" : "sideB") : "stand";
  }
  step(dt: number): void {
    dt = clamp(dt, 0, .1); this.time += dt;
    this.actors.forEach(a => this.stepActor(a, dt)); this.actors = this.actors.filter(a => !a.dead);
    this.items.forEach(it => this.stepItem(it, dt)); this.items = this.items.filter(i => i.alive);
    for (const b of this.blocks) if (b.bump < 1) b.bump = Math.min(1, b.bump + dt / .22);
    stepParticles(this.parts, dt);
    this.blocksAlpha = clamp(this.blocksAlpha + (this.finished() ? -1 : 1) * dt * 2.5, 0, 1);
  }
}
