import { clamp, ease } from "./scene";
import type { RetroLook } from "./retroSprites";
import { blockFull } from "./actions";
import type { BurrowScene, BurrowActor } from "./burrow";
import type { ScaffoldScene } from "./scaffold";
import type { JumperScene } from "./jumper";
// Canvas drawing for the action scenes. The context is already scaled to virtual pixels (see Stage);
// one sprite pixel is 2 virtual pixels, like in the approved preview.
type Ctx = CanvasRenderingContext2D;
export interface DrawOptions { ground: string }
export function paintRows(ctx: Ctx, rows: string[], palette: Record<string, string>, x: number, y: number, scale: number, flip = false, tint: string | null = null): void {
  const width = rows[0]?.length ?? 0;
  for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) {
    const ch = rows[j][i];
    if (ch === ".") continue;
    let color = palette[ch];
    if (!color) continue;
    if (tint && (ch === "k" || ch === "-")) color = tint;
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x + (flip ? width - 1 - i : i) * scale), Math.round(y + j * scale), Math.ceil(scale), Math.ceil(scale));
  }
}
interface Figure { x: number; y: number; dir: number; scale?: number; clipY?: number | null; alpha?: number; sink?: number; yo?: number; tint?: string | null }
/** x = centre, y = feet. */
function figure(ctx: Ctx, a: Figure, rows: string[], palette: Record<string, string>, width: number): void {
  const k = a.scale ?? 1, size = 32 * k;
  ctx.save();
  if (a.clipY != null) { ctx.beginPath(); ctx.rect(-1000, -1000, width + 2000, a.clipY + 1000); ctx.clip(); }
  ctx.globalAlpha = clamp(a.alpha ?? 1, 0, 1);
  paintRows(ctx, rows, palette, a.x - size / 2, a.y - size + (a.sink ?? 0) + (a.yo ?? 0), 2 * k, a.dir < 0, a.tint ?? null);
  ctx.restore();
}
const prop = (look: RetroLook, name: string, frame = 0) => look.props[name][frame % look.props[name].length];
function particles(ctx: Ctx, parts: { x: number; y: number; life: number; c: string }[]): void {
  for (const p of parts) { ctx.fillStyle = p.c; ctx.globalAlpha = clamp(p.life / .4, 0, 1); ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 2); }
  ctx.globalAlpha = 1;
}

export function drawBurrow(ctx: Ctx, s: BurrowScene, look: RetroLook, o: DrawOptions): void {
  const { gy, width } = s.layout;
  for (const h of s.holes) {
    const depth = 18 * h.open;
    ctx.globalAlpha = clamp(h.a, 0, 1);
    ctx.fillStyle = o.ground; ctx.fillRect(h.x, gy, h.w, depth);
    ctx.fillStyle = "#7a5a36";
    for (let px = h.x; px < h.x + h.w; px += 3) ctx.fillRect(px, gy + depth - 2 - (((Math.floor(px) * 7) % 5) / 5) * 2, 2, 2);
    ctx.fillRect(h.x, gy, 2, depth); ctx.fillRect(h.x + h.w - 2, gy, 2, depth);
    ctx.globalAlpha = 1;
  }
  for (const st of s.steps) { ctx.globalAlpha = clamp(st.a, 0, 1); const p = prop(look, "step"); paintRows(ctx, p.rows, p.palette, st.x, st.y, 2); ctx.globalAlpha = 1; }
  if (s.door) { ctx.globalAlpha = s.door.a; const p = prop(look, "door", s.door.f); paintRows(ctx, p.rows, p.palette, s.door.x, gy - 28, 2); ctx.globalAlpha = 1; }
  for (const a of s.actors) if (!a.hidden) figure(ctx, a, look.tux[a.spr], look.palette, width);
  for (const a of s.actors) if (a.mode === "chute" || a.mode === "land") canopy(ctx, a, look);
  particles(ctx, s.parts);
}
function canopy(ctx: Ctx, a: BurrowActor, look: RetroLook): void {
  const k = a.mode === "land" ? clamp(1 - a.mt / .55, 0, 1) : 1;
  if (k <= 0) return;
  const top = a.y - 32, cy = top - 14 + (1 - k) * 18, f = .4 + .6 * k, p = prop(look, "canopy");
  ctx.save(); ctx.translate(a.x - 16, cy); ctx.scale(1, f); paintRows(ctx, p.rows, p.palette, 0, 0, 2); ctx.restore();
  if (a.mode === "chute") {
    ctx.strokeStyle = "rgba(241,245,238,.8)"; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(a.x - 15, cy + 12); ctx.lineTo(a.x - 11, top + 12); ctx.moveTo(a.x + 15, cy + 12); ctx.lineTo(a.x + 11, top + 12); ctx.stroke();
  }
}

export function drawScaffold(ctx: Ctx, s: ScaffoldScene, look: RetroLook): void {
  const pal = look.palette, G = s.girders, width = s.layout.width;
  if (s.scaffold > 0) {
    ctx.globalAlpha = s.scaffold * .85;
    for (const g of G) { ctx.fillStyle = pal.r; ctx.fillRect(g.x0, g.y, g.x1 - g.x0, 2); ctx.fillStyle = "#8c1d4a"; for (let x = g.x0; x < g.x1; x += 12) ctx.fillRect(x, g.y + 2, 2, 2); }
    ctx.globalAlpha = s.scaffold * .7; ctx.fillStyle = pal.c;
    for (const l of s.ladders) { const t = G[l.top].y + 2, h = G[l.bot].y - t; ctx.fillRect(l.x - 8, t, 2, h); ctx.fillRect(l.x + 6, t, 2, h); for (let y = t + 4; y < t + h; y += 6) ctx.fillRect(l.x - 8, y, 16, 2); }
    ctx.globalAlpha = 1;
  }
  if (s.flag) {
    const t = s.flag.t, off = (1 - ease(t / .5) + (t > 3.2 ? ease((t - 3.2) / .4) : 0)) * 30, p = prop(look, "flag", Math.floor(t * 6));
    ctx.save(); ctx.beginPath(); ctx.rect(-1000, -1000, width + 2000, G[0].y + 1000); ctx.clip();
    paintRows(ctx, p.rows, p.palette, s.flagX + 12, G[0].y - 32 + off, 2); ctx.restore();
  }
  for (const b of s.barrels) { const p = prop(look, "barrel", Math.floor(b.t / .14)); paintRows(ctx, p.rows, p.palette, b.x - 8, b.y - 16, 2); }
  for (const a of s.actors) figure(ctx, a, look.tux[a.spr], pal, width);
  const r = s.robot;
  if (r) {
    ctx.globalAlpha = r.a;
    const shake = r.s === "lift" ? Math.floor(r.t * 30) % 2 : 0, rx = s.robotX + shake, ry = s.girders[0].y - 32;
    const p = prop(look, "robot", r.s === "lift" ? 1 : r.s === "throw" ? 2 : 0), barrel = prop(look, "barrel");
    paintRows(ctx, p.rows, p.palette, rx, ry, 2);
    if (r.s === "lift") paintRows(ctx, barrel.rows, barrel.palette, rx + 16 - 8, ry - 16, 2);
    ctx.globalAlpha = 1;
  }
}

export function drawJumper(ctx: Ctx, s: JumperScene, look: RetroLook, time: number): void {
  const width = s.layout.width;
  for (const it of s.items) {
    const name = it.kind, frames = look.props[name];
    const p = frames[(name === "coin" ? [0, 1, 2, 1][Math.floor(it.t * 14) % 4] : name === "fish" ? Math.floor(it.t * 5) : name === "star" ? Math.floor(it.t * 8) : 0) % frames.length];
    ctx.globalAlpha = clamp(it.a, 0, 1); paintRows(ctx, p.rows, p.palette, it.x - 8, it.y - 8, 2, name === "feather" && Math.floor(it.t * 2) % 2 === 1); ctx.globalAlpha = 1;
  }
  if (s.blocksAlpha > 0) {
    ctx.globalAlpha = s.blocksAlpha;
    for (const b of s.blocks) {
      const off = b.bump < 1 ? -7 * Math.sin(Math.PI * b.bump) : 0;
      const p = b.brick ? prop(look, "brick") : prop(look, "block", blockFull(b) ? (Math.floor(time * 2) % 2 ? 1 : 0) : 2);
      paintRows(ctx, p.rows, p.palette, b.x, s.ledgeTop + off, 3);
    }
    ctx.globalAlpha = 1;
  }
  for (const a of s.actors) figure(ctx, a, look.tux[a.spr], look.palette, width);
  particles(ctx, s.parts);
}
