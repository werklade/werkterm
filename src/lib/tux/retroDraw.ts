import { PX, clamp, type Grid, type Particles } from "./retroGrid";
import { retroLooks, type RetroLook } from "./retroSprites";
import type { Prop } from "./sprites";
import type { LemmingeSim, LemmingeTux } from "./lemminge";
import type { GeruestSim, GeruestTux } from "./geruest";
import { RAINBOW, POLE_X, PIPE_R, type HuepferSim, type HuepferTux } from "./huepfer";
import type { RetroSim } from "./retroSim";
// Canvas drawing of the retro simulations. The context is already scaled to virtual pixels (one sprite pixel = 2).
type Ctx = CanvasRenderingContext2D;
type Palette = Record<string, string>;

const sheets = new WeakMap<string[], Map<Palette, HTMLCanvasElement>>();
/** Each sprite is painted once into a small canvas per palette and then stamped. */
function sheetFor(rows: string[], palette: Palette): HTMLCanvasElement {
  let byPalette = sheets.get(rows);
  if (!byPalette) { byPalette = new Map(); sheets.set(rows, byPalette); }
  let canvas = byPalette.get(palette);
  if (canvas) return canvas;
  const w = rows[0].length, h = rows.length;
  canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const g = canvas.getContext("2d");
  if (g) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const ch = rows[y][x], color = palette[ch];
      if (ch === "." || ch === " " || !color) continue;
      g.fillStyle = color; g.fillRect(x, y, 1, 1);
    }
  }
  byPalette.set(palette, canvas);
  return canvas;
}
const tints = new Map<Palette, Map<string, Palette>>();
/** Same palette with the body colour (k and -) replaced. */
function tinted(palette: Palette, color: string): Palette {
  let m = tints.get(palette);
  if (!m) { m = new Map(); tints.set(palette, m); }
  let p = m.get(color);
  if (!p) { p = { ...palette, k: color, "-": color }; m.set(color, p); }
  return p;
}
function spr(ctx: Ctx, p: Prop, x: number, y: number, mirror = false, sc = PX): void {
  const c = sheetFor(p.rows, p.palette), w = c.width * sc, h = c.height * sc;
  if (mirror) { ctx.save(); ctx.translate(Math.round(x) + w, Math.round(y)); ctx.scale(-1, 1); ctx.drawImage(c, 0, 0, w, h); ctx.restore(); }
  else ctx.drawImage(c, Math.round(x), Math.round(y), w, h);
}
/** x = centre, y = feet. */
function tux(ctx: Ctx, look: RetroLook, name: string, x: number, y: number, mirror: boolean, sc = PX, palette: Palette = look.palette): void {
  spr(ctx, { rows: look.tux[name], palette }, x - 8 * sc, y - 16 * sc, mirror, sc);
}
const frameOf = (look: RetroLook, name: string, i = 0): Prop => look.props[name][i % look.props[name].length];
function particles(ctx: Ctx, parts: Particles): void {
  for (const p of parts.list) { ctx.globalAlpha = clamp(p.life / 0.25, 0, 1); ctx.fillStyle = p.color; ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size); }
  ctx.globalAlpha = 1;
}
type Ctx2 = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Layer = { canvas: CanvasImageSource; g: Ctx2 };
/** A cell tile (soil, steel, brick) that replaces the character of a cell; drawn at cell width, 16 pixels high, crisp. */
type Tile = { prop: Prop; mirror: boolean };
type TileAt = (r: number, c: number) => Tile | null;
/** Cached cover per grid; rebuilt only when Grid.version, the background, the scale or the tile view changes. Null: no canvas available. */
const covers = new WeakMap<Grid, { layer: Layer | null; version: number; ground: string; scale: number; tiles: boolean }>();
function newLayer(w: number, h: number): Layer | null {
  try {
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
      const g = canvas.getContext("2d");
      if (g) return { canvas, g };
    }
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(w, h), g = canvas.getContext("2d");
      if (g) return { canvas, g };
    }
  } catch { /* no canvas (tests): fall back to direct drawing */ }
  return null;
}
/** Draws a tile into cell (r, c): the lower 16 pixels of the cell, cell wide, without smoothing. */
function drawTile(g: Ctx2, grid: Grid, p: Prop, r: number, c: number, mirror: boolean): void {
  const img = sheetFor(p.rows, p.palette), x = c * grid.cw, y = (r + 1) * grid.ch - 16, w = grid.cw;
  g.imageSmoothingEnabled = false;
  if (mirror) { g.save(); g.translate(x + w, y); g.scale(-1, 1); g.drawImage(img, 0, 0, w, 16); g.restore(); }
  else g.drawImage(img, x, y, w, 16);
}
function paintCover(g: Ctx2, grid: Grid, ground: string, tileAt: TileAt | null): void {
  g.fillStyle = ground;
  for (const k of grid.destroyed) g.fillRect((k % grid.cols) * grid.cw, Math.floor(k / grid.cols) * grid.ch, grid.cw, grid.ch);
  if (!tileAt) return;
  for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
    const t = tileAt(r, c);
    if (!t) continue;
    // The background first hides the whole character, then the tile replaces it.
    g.fillStyle = ground; g.fillRect(c * grid.cw, r * grid.ch, grid.cw, grid.ch);
    drawTile(g, grid, t.prop, r, c, t.mirror);
  }
}
/**
 * Destroyed characters are covered with the terminal background, tiles replace characters while the Tuxes are active
 * (overlay only; the text returns when the overlay ends).
 */
function cover(ctx: Ctx, grid: Grid, ground: string, tileAt: TileAt | null = null): void {
  if (!grid.destroyed.size && !tileAt) return;
  const scale = typeof ctx.getTransform === "function" ? Math.abs(ctx.getTransform().a) || 1 : 1, tiles = tileAt !== null;
  let c = covers.get(grid);
  if (!c || c.version !== grid.version || c.ground !== ground || c.scale !== scale || c.tiles !== tiles) {
    const w = Math.max(1, Math.ceil(grid.width * scale)), h = Math.max(1, Math.ceil(grid.height * scale));
    const layer = c?.layer && c.scale === scale ? c.layer : newLayer(w, h);
    if (layer) {
      layer.g.setTransform(1, 0, 0, 1, 0, 0); layer.g.clearRect(0, 0, w, h); layer.g.scale(scale, scale);
      paintCover(layer.g, grid, ground, tileAt);
    }
    c = { layer, version: grid.version, ground, scale, tiles };
    covers.set(grid, c);
  }
  // The layer has device resolution; drawn 1:1 under the scaled context (no stretching from rounding up).
  if (c.layer) ctx.drawImage(c.layer.canvas, 0, 0, Math.max(1, Math.ceil(grid.width * scale)) / scale, Math.max(1, Math.ceil(grid.height * scale)) / scale);
  else paintCover(ctx, grid, ground, tileAt);
}
/** Soil rows of Retro Lemminge: clods of soil, steel plates for steel words; every 2nd column mirrored. */
function lemmingeTiles(sim: LemmingeSim): TileAt | null {
  if (!sim.tiles) return null;
  const look = retroLooks.lemminge, earth = frameOf(look, "earth"), steel = frameOf(look, "steel"), g = sim.grid;
  return (r, c) => (sim.soilRow(r) && g.hasChar(r, c) ? { prop: g.isSteel(r, c) ? steel : earth, mirror: c % 2 === 1 } : null);
}
/** Brick rows of Retro Hüpfer: the 9 x 16 brick tile. */
function huepferTiles(sim: HuepferSim): TileAt | null {
  if (!sim.tiles) return null;
  const brick = frameOf(retroLooks.huepfer, "brickTile"), g = sim.grid;
  return (r, c) => (sim.brickRow(r) && g.hasChar(r, c) ? { prop: brick, mirror: false } : null);
}

// ---------- Retro Lemminge ----------
const BADGE_STATES = new Set<LemmingeTux["state"]>(["walk", "stop", "dig", "build", "fall", "shrug", "tunnel", "diag", "climb"]);
/** The climbed wall: a narrow edge of soil from the lower floor up to the upper one, in front of the climber. */
function climbWall(ctx: Ctx, t: LemmingeTux): void {
  const x = Math.round(t.dir > 0 ? t.x + 9 : t.x - 12), top = Math.round(t.cy), h = Math.max(0, Math.round(t.cfrom - t.cy));
  ctx.fillStyle = "#6b4a2a"; ctx.fillRect(x, top, 3, h);
  ctx.fillStyle = "#43301c"; ctx.fillRect(t.dir > 0 ? x + 2 : x, top, 1, h);
  ctx.fillStyle = "#7ccf3a"; ctx.fillRect(x, top, 3, 1);
}
function lemmingeTux(ctx: Ctx, sim: LemmingeSim, look: RetroLook, t: LemmingeTux): void {
  if (t.state === "enter") return;
  let name: string | null = "stand", mirror = t.dir < 0, sc = PX, alpha = 1;
  switch (t.state) {
    case "fall": case "float": name = "hang"; mirror = false; break;
    case "walk": name = Math.floor(t.anim / 0.18) % 2 ? "sideB" : "sideA"; break;
    case "dig": name = Math.floor(t.anim / 0.12) % 2 ? "digB" : "digA"; mirror = false; break;
    case "tunnel": case "diag": name = Math.floor(t.anim / 0.15) % 2 ? "tunB" : "tunA"; break;
    case "shrug": name = "shrug"; mirror = false; break;
    case "climb": name = Math.floor(t.anim / 0.25) % 2 ? "climbB" : "climbA"; mirror = false; climbWall(ctx, t); break;
    case "pop": name = "plopp"; mirror = false; break;
    case "stop": name = Math.floor(t.anim / 0.4) % 2 ? "stopB" : "stopA"; mirror = false; break;
    case "build": name = Math.floor(t.t / 0.3) % 2 ? "buildB" : "buildA"; break;
    case "die": name = t.t < 0.2 ? "squash" : t.t < 0.4 ? "plopp" : null; mirror = false; break;
    case "exit": name = Math.floor(t.t / 0.1) % 2 ? "sideB" : "sideA"; mirror = false; sc = PX * (1 - 0.8 * Math.min(1, t.t / 0.5)); break;
    case "vanish": name = "stand"; mirror = false; alpha = 1 - t.t / 0.3; break;
  }
  ctx.globalAlpha = clamp(alpha, 0, 1);
  if (name) tux(ctx, look, name, t.x, t.y, mirror, sc);
  ctx.globalAlpha = 1;
  if ((t.umbrella || t.climber) && BADGE_STATES.has(t.state)) spr(ctx, frameOf(look, t.umbrella ? "badge" : "badgeClimb"), t.x - 7, t.y - 44 + Math.round(Math.sin(sim.time * 5 + t.id)));
  if (t.state === "float") {
    spr(ctx, frameOf(look, "canopy"), t.x - 16, t.y - 42);
    ctx.fillStyle = "#f1f5ee"; ctx.fillRect(Math.round(t.x - 15), Math.round(t.y - 30), 1, 8); ctx.fillRect(Math.round(t.x + 14), Math.round(t.y - 30), 1, 8);
  }
}
function drawLemminge(ctx: Ctx, sim: LemmingeSim): void {
  const look = retroLooks.lemminge, g = sim.grid, gy = g.floorY(sim.groundRow), w = g.width, bar = (sim.groundRow + 1) * g.ch - gy;
  ctx.fillStyle = "#2a2117"; ctx.fillRect(0, gy, w, bar);
  ctx.fillStyle = "#4f9a22"; ctx.fillRect(0, gy, w, 2);
  ctx.fillStyle = "#7ccf3a"; for (let x = 3; x < w; x += 14) ctx.fillRect(x, gy, 2, 1);
  ctx.fillStyle = "#3b2a18"; for (let x = 0; x < w; x += 12) { ctx.fillRect(x + 2, gy + 5, 3, 2); if (bar > 11) ctx.fillRect(x + 8, gy + 9, 3, 2); }
  spr(ctx, frameOf(look, "door", sim.doorT > 0.45 ? 1 : sim.doorT > 0 ? 2 : 0), sim.doorX - 10, gy - 28);
  for (const h of sim.hatches) spr(ctx, frameOf(look, h.t > 0.15 && h.t < 0.9 ? "hatchOpen" : "hatchClosed"), h.x - 16, 0);
  for (const s of sim.steps) { if (s.age > 12 && Math.floor(s.age * 6) % 2) continue; spr(ctx, frameOf(look, "step"), s.x1, s.y); }
  for (const t of sim.tuxes) lemmingeTux(ctx, sim, look, t);
  particles(ctx, sim.parts);
}

// ---------- Retro Gerüst ----------
function geruestTux(ctx: Ctx, look: RetroLook, t: GeruestTux): void {
  if (t.state === "wait") return;
  const mirror = t.dir < 0, y = t.y - t.lift;
  if (t.state === "beam" || t.state === "beamout") {
    const u = t.state === "beam" ? t.t / 0.6 : 1 - t.t / 0.6, h = Math.round(32 * clamp(u, 0, 1));
    ctx.save(); ctx.beginPath(); ctx.rect(t.x - 16, t.y - h, 32, h); ctx.clip();
    tux(ctx, look, t.state === "beam" ? "stand" : "cheer", t.x, t.y, false); ctx.restore();
    ctx.fillStyle = "#19e6ff"; ctx.fillRect(t.x - 16, t.y - h, 32, 2);
    ctx.globalAlpha = 0.2; ctx.fillRect(t.x - 14, t.y - 34, 28, 34); ctx.globalAlpha = 1;
    return;
  }
  let name: string | null = "stand";
  switch (t.state) {
    case "walk": name = Math.floor(t.anim / 0.18) % 2 ? "sideB" : "sideA"; break;
    case "climb": name = Math.floor(t.anim / 0.2) % 2 ? "climbB" : "climbA"; break;
    case "jump": name = "jumpG"; break;
    case "hit": name = Math.floor(t.t / 0.08) % 2 === 0 ? "hit" : null; break;
    case "cheer": name = Math.floor(t.t / 0.25) % 2 ? "cheer" : "stand"; break;
  }
  if (name) tux(ctx, look, name, t.x, y, mirror && (t.state === "walk" || t.state === "jump"));
}
function drawGeruest(ctx: Ctx, sim: GeruestSim, time: number): void {
  const look = retroLooks.geruest, G = sim.girders;
  ctx.save();
  if (sim.shake > 0) ctx.translate(Math.round(Math.sin(time * 90) * 2 * sim.shake / 0.45), 0);
  for (const g of G) {
    ctx.fillStyle = "#8c1d4a"; ctx.fillRect(g.x1, g.y, g.x2 - g.x1, 4);
    ctx.fillStyle = "#ff4d6d"; ctx.fillRect(g.x1, g.y, g.x2 - g.x1, 1);
    ctx.fillStyle = "#3a0c22"; for (let x = g.x1 + 2; x < g.x2 - 2; x += 8) ctx.fillRect(x, g.y + 1, 2, 2);
  }
  ctx.fillStyle = "#19e6ff";
  for (const l of sim.ladders) {
    const y0 = G[l.hi].y, y1 = G[l.lo].y;
    ctx.fillRect(l.x - 4, y0, 2, y1 - y0); ctx.fillRect(l.x + 2, y0, 2, y1 - y0);
    for (let y = y0 + 3; y < y1; y += 5) ctx.fillRect(l.x - 4, y, 8, 1);
  }
  const sg = sim.start;
  ctx.fillRect(sg.x1 + 2, sg.y - 2, 24, 2); ctx.fillRect(sg.x1 + 2, sg.y - 6, 2, 4);
  spr(ctx, frameOf(look, "flag", Math.floor(time * 5)), sim.flagX - 6, G[sim.goalG].y - 32);
  const robot = sim.robot;
  if (robot) {
    const rf = robot.state === "idle" ? 0 : robot.state === "lift" ? 1 : robot.state === "throw" ? 2 : 3;
    const off = robot.state === "stomp" && robot.t < 0.35 ? -Math.round(12 * Math.sin(Math.PI * robot.t / 0.35)) : 0, ry = G[sim.goalG].y - 48 + off;
    spr(ctx, frameOf(look, "robot", rf), robot.x, ry);
    if (robot.state === "lift") spr(ctx, frameOf(look, "barrel", 0), robot.x + 16, ry - 16);
  }
  for (const b of sim.barrels) spr(ctx, frameOf(look, "barrel", Math.floor(b.anim / 0.12)), b.x - 8, b.y - 8);
  for (const t of sim.tuxes) geruestTux(ctx, look, t);
  ctx.restore();
  particles(ctx, sim.parts);
}

// ---------- Retro Hüpfer ----------
function huepferTux(ctx: Ctx, sim: HuepferSim, look: RetroLook, t: HuepferTux): void {
  if (t.state === "enter") return;
  let name = "stand", mirror = t.dir < 0, alpha = 1;
  switch (t.state) {
    case "walk": case "exit": name = Math.floor(t.anim / 0.15) % 2 ? "sideB" : "sideA"; break;
    case "hop": case "jumpup": case "bumpjump": name = "jump"; mirror = false; break;
    case "fall": name = Math.floor(t.t / 0.12) % 2 ? "fallB" : "fallA"; mirror = false; break;
    case "crouch": name = "crouch"; mirror = false; break;
    case "slam": name = "slam"; mirror = false; break;
    case "cheer": name = Math.floor(t.t / 0.2) % 2 ? "jump" : "stand"; mirror = false; break;
    case "soar": name = "soar"; mirror = false; break;
    case "eat": name = Math.floor(t.anim / 0.15) % 2 ? "eatB" : "eatA"; break;
    case "vanish": mirror = false; alpha = 1 - t.t / 0.3; break;
    case "leap": name = "jump"; alpha = t.t < 0.3 ? 1 : 1 - (t.t - 0.3) / 0.25; break;
  }
  const palette = t.star > 0 ? tinted(look.palette, RAINBOW[Math.floor(sim.time * 12) % RAINBOW.length]) : look.palette;
  const big = t.big > 0 && !(t.big < 1 && Math.floor(sim.time * 10) % 2);
  ctx.globalAlpha = clamp(alpha, 0, 1);
  tux(ctx, look, name, t.x, t.y, mirror, big ? 3 : PX, palette);
  ctx.globalAlpha = 1;
}
function pipeDown(ctx: Ctx, x: number, a: number): void {
  ctx.globalAlpha = clamp(a, 0, 1);
  ctx.fillStyle = "#14562a"; ctx.fillRect(x - 17, 0, 34, 14); ctx.fillRect(x - 20, 8, 40, 8);
  ctx.fillStyle = "#2fa24a"; ctx.fillRect(x - 15, 0, 30, 8); ctx.fillRect(x - 18, 9, 36, 6);
  ctx.fillStyle = "#4cd964"; ctx.fillRect(x - 14, 0, 4, 8); ctx.fillRect(x - 17, 9, 4, 6);
  ctx.globalAlpha = 1;
}
function drawHuepfer(ctx: Ctx, sim: HuepferSim): void {
  const look = retroLooks.huepfer, g = sim.grid, gy = g.floorY(sim.groundRow), time = sim.time;
  ctx.save(); ctx.beginPath(); ctx.rect(0, gy, g.width, (sim.groundRow + 1) * g.ch - gy); ctx.clip();
  for (let x = 0; x < g.width; x += 16) spr(ctx, frameOf(look, "brick"), x, gy);
  ctx.restore();
  for (const it of sim.items) {
    const f = it.kind === "coin" ? frameOf(look, "coin", Math.floor(it.t / 0.09)) : it.kind === "fish" ? frameOf(look, "fish", Math.floor(time * 4)) : it.kind === "star" ? frameOf(look, "star", Math.floor(time * 8)) : frameOf(look, "feather");
    spr(ctx, f, it.x - 8, it.y - 16, it.kind === "fish" && it.vx < 0);
  }
  for (const b of sim.blocks) {
    const off = b.bump > 0 ? Math.round(6 * Math.sin(Math.PI * (1 - b.bump / 0.2))) : 0, top = b.y - 16 - off;
    ctx.globalAlpha = b.age > 28 ? 0.5 : 1;
    spr(ctx, frameOf(look, "block", b.state === "empty" ? 2 : Math.floor(time * 2.5) % 2), b.x - 8, top);
    if (b.type === "multi" && b.state !== "empty") { ctx.fillStyle = "#fcc419"; for (let i = 0; i < b.left; i++) ctx.fillRect(b.x - 8 + i * 4, top - 3, 3, 2); }
    ctx.globalAlpha = 1;
  }
  // A broken brick flashes briefly: the brick tile with a white shimmer.
  for (const f of sim.flashes) {
    drawTile(ctx, g, frameOf(look, "brickTile"), f.r, f.c, false);
    ctx.globalAlpha = 0.5; ctx.fillStyle = "#ffffff"; ctx.fillRect(f.c * g.cw, (f.r + 1) * g.ch - 16, g.cw, 16); ctx.globalAlpha = 1;
  }
  // Goal bottom left: the flag climbs the pole when a Tux touches it.
  ctx.fillStyle = "#f1f5ee"; ctx.fillRect(POLE_X, gy - 100, 3, 100);
  ctx.fillStyle = "#fcc419"; ctx.fillRect(POLE_X - 1, gy - 104, 5, 5);
  const fy = gy - 18 - Math.round(sim.flagLv * 74);
  ctx.fillStyle = "#e8412e";
  for (let i = 0; i < 7; i++) ctx.fillRect(POLE_X + 3, fy + i * 2, 18 - i * 2 - (sim.flagLv > 0 && i % 2 ? Math.round(Math.sin(time * 8)) : 0), 2);
  for (const t of sim.tuxes) huepferTux(ctx, sim, look, t);
  for (const p of sim.pipes) pipeDown(ctx, p.x, p.t > 1.2 ? (1.5 - p.t) / 0.3 : 1);
  ctx.fillStyle = "#14562a"; ctx.fillRect(0, gy - 38, PIPE_R, 38); ctx.fillRect(PIPE_R - 4, gy - 40, 8, 42);
  ctx.fillStyle = "#2fa24a"; ctx.fillRect(2, gy - 36, PIPE_R - 6, 34); ctx.fillRect(PIPE_R - 2, gy - 38, 6, 38);
  ctx.fillStyle = "#4cd964"; ctx.fillRect(2, gy - 36, PIPE_R - 6, 4); ctx.fillRect(PIPE_R + 2, gy - 38, 2, 38);
  particles(ctx, sim.parts);
}

/** Paints one frame of a simulation; `ground` is the terminal background that hides destroyed characters. */
export function drawRetro(ctx: Ctx, sim: RetroSim, ground: string): void {
  if (sim.id === "lemminge") { cover(ctx, sim.grid, ground, lemmingeTiles(sim)); drawLemminge(ctx, sim); }
  else if (sim.id === "geruest") { cover(ctx, sim.grid, ground); drawGeruest(ctx, sim, sim.time); }
  else { cover(ctx, sim.grid, ground, huepferTiles(sim)); drawHuepfer(ctx, sim); }
}
