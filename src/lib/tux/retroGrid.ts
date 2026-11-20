import type { RetroId } from "./retroSprites";
// Shared pieces of the three retro simulations: text grid, particles, floors, idle-time limit.
// Everything works in virtual pixels where one sprite pixel is PX (= 2) pixels; a Tux is 32 pixels high.
export type Rng = () => number;
export const PX = 2;
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const rnd = (rng: Rng, a: number, b: number) => a + rng() * (b - a);
export const rint = (rng: Rng, a: number, b: number) => Math.floor(rnd(rng, a, b + 1));
export const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
export type Dir = 1 | -1;
export const flip = (d: Dir): Dir => (d === 1 ? -1 : 1);
/** After this many seconds of running animation the Tuxes leave on their own (10 minutes). */
export const LEAVE_AFTER = 600;

/** What the overlay knows about the terminal when a simulation starts. */
export interface RetroInput { lines: string[]; rows: number; cols: number; cellWidth: number; cellHeight: number; pixel: number }
export interface RetroStage { scale: number; cw: number; ch: number; groundRow: number }
/** Minimum stage size in virtual pixels per design (ground distance from the top, width). */
export const stageNeeds: Record<RetroId, { gy: number; width: number }> = {
  lemminge: { gy: 70, width: 380 },
  geruest: { gy: 0, width: 460 },
  huepfer: { gy: 134, width: 440 },
};
export function lastTextRow(lines: string[]): number {
  for (let row = lines.length - 1; row >= 0; row--) if (lines[row].trim() !== "") return row;
  return -1;
}
/** Scale and ground row; the ground lies on the line below the last text. Null if the terminal is too small. */
export function retroStage(id: RetroId, input: RetroInput): RetroStage | null {
  const { rows, cols, cellWidth, cellHeight, pixel } = input;
  if (!(rows > 0 && cols > 0 && cellWidth > 0 && cellHeight > 0 && pixel > 0)) return null;
  const scale = pixel / PX, cw = cellWidth / scale, ch = cellHeight / scale, needs = stageNeeds[id];
  if (cols * cw < needs.width) return null;
  if (id === "geruest") return { scale, cw, ch, groundRow: -1 };
  const minRow = Math.ceil(needs.gy / ch);
  const groundRow = Math.min(rows - 1, Math.max(minRow, lastTextRow(input.lines) + 1));
  return groundRow < minRow ? null : { scale, cw, ch, groundRow };
}

/** The text of the terminal as cells. Destroyed cells are an overlay only; the terminal buffer stays untouched. */
export class Grid {
  readonly width: number;
  readonly height: number;
  readonly destroyed = new Set<number>();
  /** Increases whenever cells are destroyed or restored. */
  version = 0;
  private readonly text: Uint8Array;
  private readonly base: Uint8Array;
  /** `bridge`: gaps of up to this many spaces between two characters of a row still count as floor. */
  constructor(lines: string[], readonly rows: number, readonly cols: number, readonly cw: number, readonly ch: number, bridge: number) {
    this.width = cols * cw; this.height = rows * ch;
    this.text = new Uint8Array(rows * cols); this.base = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      const line = lines[r] ?? "";
      let prev = -1;
      for (let c = 0; c < cols; c++) {
        const char = line.charAt(c);
        if (char === "" || char.trim() === "") continue;
        this.text[r * cols + c] = 1; this.base[r * cols + c] = 1;
        const gap = c - prev - 1;
        if (prev >= 0 && gap > 0 && gap <= bridge) for (let k = prev + 1; k < c; k++) this.base[r * cols + k] = 1;
        prev = c;
      }
    }
  }
  private inside(r: number, c: number): boolean { return r >= 0 && r < this.rows && c >= 0 && c < this.cols; }
  /** y of the feet of a Tux walking on the text of row r. */
  floorY(r: number): number { return r * this.ch + this.ch * 0.3; }
  colOf(x: number): number { return Math.floor(x / this.cw); }
  /** The cell held a character originally (ignores destruction). */
  hasText(r: number, c: number): boolean { return this.inside(r, c) && this.text[r * this.cols + c] === 1; }
  /** The cell shows a character right now. */
  hasChar(r: number, c: number): boolean { return this.hasText(r, c) && !this.destroyed.has(r * this.cols + c); }
  solid(r: number, c: number): boolean { return this.inside(r, c) && this.base[r * this.cols + c] === 1 && !this.destroyed.has(r * this.cols + c); }
  /** Floor over a space between two words (not a character itself). */
  bridged(r: number, c: number): boolean { return this.solid(r, c) && !this.hasText(r, c); }
  destroy(r: number, c: number): boolean {
    if (!this.inside(r, c)) return false;
    const k = r * this.cols + c;
    if (this.base[k] !== 1 || this.destroyed.has(k)) return false;
    this.destroyed.add(k); this.version++;
    return true;
  }
  restore(): void { this.destroyed.clear(); this.version++; }
  /** First and last column with a character in row r, or null for an empty row. */
  range(r: number): [number, number] | null {
    let a = -1, b = -1;
    for (let c = 0; c < this.cols; c++) if (this.hasText(r, c)) { if (a < 0) a = c; b = c; }
    return a < 0 ? null : [a, b];
  }
  /** Rows with text, top to bottom. */
  textRows(): number[] {
    const out: number[] = [];
    for (let r = 0; r < this.rows; r++) if (this.range(r)) out.push(r);
    return out;
  }
}

export interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string; size: number; g: number }
export class Particles {
  list: Particle[] = [];
  add(x: number, y: number, vx: number, vy: number, life: number, color: string, size: number, g: number): void {
    if (this.list.length < 300) this.list.push({ x, y, vx, vy, life, color, size, g });
  }
  update(dt: number, bottom: number): void {
    // Compacts in place (no new array per sub-step).
    const list = this.list;
    let n = 0;
    for (const p of list) {
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.life > 0 && p.y < bottom + 20) list[n++] = p;
    }
    list.length = n;
  }
}

/** A platform of its own (stairs, empty blocks): x range and y of the walking surface. */
export interface Plank { x1: number; x2: number; y: number }
export interface Floor { y: number; row: number }
/** Floors under a Tux: rows of text, optionally the ground row, and extra planks (row -1). */
export class Surfaces {
  constructor(private readonly grid: Grid, private readonly lastRow: number, private readonly hasGround: boolean, private readonly planks: () => Plank[]) {}
  solidAt(r: number, c: number): boolean { return (this.hasGround && r === this.lastRow) || this.grid.solid(r, c); }
  /** The floor closest to y within tol at x, or null (the Tux walks off an edge). */
  nearest(x: number, y: number, tol: number): Floor | null {
    const c = this.grid.colOf(x);
    let best: Floor | null = null;
    for (let r = 0; r <= this.lastRow; r++) {
      const fy = this.grid.floorY(r);
      if (fy < y - tol || fy > y + tol || !this.solidAt(r, c)) continue;
      if (!best || Math.abs(fy - y) < Math.abs(best.y - y)) best = { y: fy, row: r };
    }
    for (const s of this.planks()) if (x >= s.x1 && x <= s.x2 && s.y >= y - tol && s.y <= y + tol && (!best || Math.abs(s.y - y) < Math.abs(best.y - y))) best = { y: s.y, row: -1 };
    return best;
  }
  /** The highest floor between y0 and y1 at x (something to land on), or null. */
  landing(x: number, y0: number, y1: number): Floor | null {
    const c = this.grid.colOf(x);
    let best: Floor | null = null;
    for (let r = 0; r <= this.lastRow; r++) {
      const fy = this.grid.floorY(r);
      if (fy < y0 || fy > y1 || !this.solidAt(r, c)) continue;
      if (!best || fy < best.y) best = { y: fy, row: r };
    }
    for (const s of this.planks()) if (x >= s.x1 && x <= s.x2 && s.y >= y0 && s.y <= y1 && (!best || s.y < best.y)) best = { y: s.y, row: -1 };
    return best;
  }
  /** First row below the top with a floor at column c; the ground row if there is none. */
  firstRow(c: number): number {
    for (let r = 1; r <= this.lastRow; r++) if (this.solidAt(r, c)) return r;
    return this.lastRow;
  }
}

/** Common clock of the simulations: fixed sub-steps, the 10-minute limit after which the Tuxes leave. */
export abstract class SimBase {
  abstract readonly id: RetroId;
  time = 0;
  /** True once the Tuxes should leave: no new Tuxes, the present ones go away. */
  closing = false;
  readonly parts = new Particles();
  protected nextId = 1;
  constructor(readonly grid: Grid, protected readonly rng: Rng, readonly leaveAfter: number = LEAVE_AFTER) {}
  /** Closing and nothing left on stage: the overlay may stop. */
  abstract get done(): boolean;
  protected abstract step(dt: number): void;
  beginLeave(): void { this.closing = true; }
  update(dt: number): void {
    const total = clamp(dt, 0, 0.1), n = Math.max(1, Math.ceil(total * 45)), h = total / n;
    for (let i = 0; i < n; i++) {
      this.time += h;
      if (!this.closing && this.time > this.leaveAfter) this.closing = true;
      this.parts.update(h, this.grid.height);
      this.step(h);
    }
  }
}
