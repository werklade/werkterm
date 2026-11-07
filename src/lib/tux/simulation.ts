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
/** Seconds one dig takes, long enough to show the scooping animation. */
export const DIG_TIME = 1.5;
/** Solid cells ahead of x on this row before an edge or hole. */
export function groundAhead(platforms: Platform[], holes: Hole[], row: number, x: number, direction: number): number {
  let n = 0;
  while (n < 400 && solid(platforms, holes, row, x + direction * (n + 1))) n++;
  return n;
}
export interface Tux { x: number; y: number; vy: number; direction: number; state: "fall" | "walk" | "dig" | "exit" | "gone"; age: number; wait: number; floor: number; leave: number; sliding: boolean }
/** Flapping caps the fall speed (rows/s); stretches longer than SLIDE_MIN cells are crossed on the belly. */
export const MAX_FALL = 5, SLIDE_MIN = 10, SLIDE_SPEED = 9;
/** Leaving: wave while the corner folds open, slip behind it, then close it. */
export const LEAVE = { wave: 1.6, slip: .5, close: .5 };
export function createTux(x: number, direction = 1, wait = 0): Tux { return { x, y: -2, vy: 0, direction, state: "fall", age: 0, wait, floor: -1, leave: -1, sliding: false }; }
export function stepTux(t: Tux, dt: number, platforms: Platform[], rows: number, random = Math.random, holes: Hole[] = [], cols = Infinity): void {
  dt = Math.max(0, Math.min(dt, .1));
  if (t.wait > 0) { t.wait -= dt; return; }
  t.age += dt;
  if (t.state === "gone") return;
  if (t.state === "exit") {
    if (t.leave < 0) {
      const edge = t.direction > 0 ? cols - 2.5 : 2.5;
      t.sliding = Math.abs(edge - t.x) > SLIDE_MIN / 2;
      t.x += t.direction * dt * (t.sliding ? SLIDE_SPEED : 6);
      if (t.direction > 0 ? t.x >= edge : t.x <= edge) { t.x = edge; t.leave = 0; t.sliding = false; }
    } else {
      t.leave += dt;
      if (t.leave > LEAVE.wave && t.leave <= LEAVE.wave + LEAVE.slip) t.x += t.direction * dt * 6;
      if (t.leave >= LEAVE.wave + LEAVE.slip + LEAVE.close) t.state = "gone";
    }
    return;
  }
  if (t.state === "dig") {
    if (t.age > DIG_TIME) { holes.push(digSpan(t)); t.state = "fall"; t.y += 1; t.vy = 0; t.age = 0; }
    return;
  }
  if (t.state === "walk") {
    // Slide while plenty of ground lies ahead; stand up again before the end.
    const ahead = groundAhead(platforms, holes, t.floor, t.x, t.direction);
    t.sliding = t.sliding ? ahead > 2 : ahead > SLIDE_MIN;
    t.x += t.direction * dt * (t.sliding ? SLIDE_SPEED : 3);
    if (!solid(platforms, holes, t.floor, t.x)) { t.state = "fall"; t.sliding = false; t.y += .05; t.vy = 0; t.age = 0; }
    else if (!t.sliding && t.age > .4 && random() < dt * .6) { t.state = "dig"; t.age = 0; }
    return;
  }
  const before = t.y;
  t.vy = Math.min(MAX_FALL, t.vy + dt * 18); t.y += t.vy * dt;
  const floor = platforms.filter(p => p.y >= before && p.y <= t.y && solid([p], holes, p.y, t.x)).sort((a, b) => a.y - b.y)[0];
  if (floor) { t.y = floor.y; t.floor = floor.y; t.state = "walk"; t.age = 0; t.vy = 0; }
  else if (t.y >= rows) { t.y = rows; t.state = "exit"; t.age = 0; }
}
