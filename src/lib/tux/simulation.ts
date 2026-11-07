export interface Platform { start: number; end: number; y: number }
export function platformsFromLines(lines: string[]): Platform[] {
  return lines.flatMap((line, y) => Array.from(line.matchAll(/\S+/gu), match => ({ start: match.index, end: match.index + match[0].length, y })));
}
export class IdleClock {
  constructor(public lastActivity: number) {}
  activity(now: number): void { this.lastActivity = now; }
  remaining(now: number, delay: number): number { return Math.max(0, delay - (now - this.lastActivity)); }
}
/** Cells a tux dug away; drawn over the text only, the terminal buffer stays untouched. */
export interface Hole { row: number; start: number; end: number }
const solid = (platforms: Platform[], holes: Hole[], row: number, x: number) =>
  platforms.some(p => p.y === row && x >= p.start && x < p.end) && !holes.some(h => h.row === row && x >= h.start && x < h.end);
/** A dig spans wider than the ~5-cell sprite so the damage shows beside it. */
export const digSpan = (t: { x: number; floor: number }): Hole => ({ row: t.floor, start: Math.floor(t.x) - 3, end: Math.floor(t.x) + 4 });
export interface Tux { x: number; y: number; vy: number; direction: number; state: "fall" | "walk" | "dig" | "exit"; age: number; wait: number; floor: number }
export function createTux(x: number, direction = 1, wait = 0): Tux { return { x, y: -2, vy: 0, direction, state: "fall", age: 0, wait, floor: -1 }; }
export function stepTux(t: Tux, dt: number, platforms: Platform[], rows: number, random = Math.random, holes: Hole[] = []): void {
  dt = Math.max(0, Math.min(dt, .1));
  if (t.wait > 0) { t.wait -= dt; return; }
  t.age += dt;
  if (t.state === "exit") { t.x += t.direction * dt * 6; return; }
  if (t.state === "dig") {
    if (t.age > .9) { holes.push(digSpan(t)); t.state = "fall"; t.y += 1; t.vy = 0; t.age = 0; }
    return;
  }
  if (t.state === "walk") {
    t.x += t.direction * dt * 3;
    if (!solid(platforms, holes, t.floor, t.x)) { t.state = "fall"; t.y += .05; t.vy = 0; t.age = 0; }
    else if (t.age > .4 && random() < dt * .6) { t.state = "dig"; t.age = 0; }
    return;
  }
  const before = t.y;
  t.vy += dt * 18; t.y += t.vy * dt;
  const floor = platforms.filter(p => p.y >= before && p.y <= t.y && solid([p], holes, p.y, t.x)).sort((a, b) => a.y - b.y)[0];
  if (floor) { t.y = floor.y; t.floor = floor.y; t.state = "walk"; t.age = 0; t.vy = 0; }
  else if (t.y >= rows) { t.y = rows; t.state = "exit"; t.age = 0; }
}
