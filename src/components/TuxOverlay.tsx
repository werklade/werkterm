import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { createTux, TUX_COLORS, MARGIN, DIG_TIME, digSpan, IdleClock, LEAVE, platformsFromLines, stepTux, type Hole } from "../lib/tux/simulation";
import { helmet, palette, sprites } from "../lib/tux/sprites";
import { ActionGate, actionDelay, actionsAllowed, planAction, type ActionPlan } from "../lib/tux/actions";
import { retroIdForDesign, retroLooks } from "../lib/tux/retroSprites";
import { createScene, drawScene, type RetroScene } from "../lib/tux/retroScenes";
import { SCENE_TIMEOUT } from "../lib/tux/scene";

export const tuxTestEvent = "werkterm:tux-test";
export function TuxOverlay({ terminal, enabled, minutes, count, visible, active, design }: { terminal: Terminal | null; enabled: boolean; minutes: number; count: number; visible: boolean; active: boolean; design: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Only the retro id restarts the overlay; switching between other designs keeps running tuxes.
  const retro = retroIdForDesign(design);
  useEffect(() => {
    const target = terminal?.element;
    const surface = canvas.current;
    if (!terminal || !target || !surface) return;
    const context = surface.getContext("2d");
    if (!context) return;
    const clock = new IdleClock(performance.now());
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let running = false;
    let last = 0;
    let tuxes = [createTux(0)];
    // Retro designs: fixed body colour per design and their own sprite look; all other designs keep the random colours.
    const look = retro ? retroLooks[retro] : null;
    const tuxPalette = look ? { ...palette, ...look.palette } : palette;
    const view = look ? { ...sprites, ...look.base } : sprites;
    const bodyColor = look?.palette.k;
    const randomColor = () => bodyColor ?? TUX_COLORS[Math.floor(Math.random() * TUX_COLORS.length)];
    // Actions: at most one per idle phase (the gate is armed by activity), only with Tux enabled and motion allowed.
    const gate = new ActionGate();
    let scene: RetroScene | null = null, plan: ActionPlan | null = null, runTime = 0, actionAt = Infinity;
    const pixelSize = () => Math.max(1, Math.floor(cellHeight * 2 / 16));
    const beginAction = () => {
      actionAt = Infinity;
      if (!retro || !gate.available || !actionsAllowed({ enabled, reducedMotion: motion.matches, design: retro })) return;
      const next = planAction(retro, { lines, rows: terminal.rows, cols: terminal.cols, cellWidth, cellHeight, pixel: pixelSize() }, Math.random);
      if (!next || !gate.take()) return;
      plan = next; scene = createScene(next, Math.random); runTime = 0;
    };
    let platforms = platformsFromLines([]);
    let holes: Hole[] = [];
    let lines: string[] = [];
    let width = 0, height = 0, cellWidth = 0, cellHeight = 0;
    const available = () => visible && document.visibilityState === "visible" && target.getClientRects().length > 0 && target.clientWidth > 0 && target.clientHeight > 0;
    const clear = () => { running = false; scene = null; plan = null; actionAt = Infinity; cancelAnimationFrame(frame); clearTimeout(timer); context.clearRect(0, 0, surface.width, surface.height); };
    const draw = (now: number) => {
      if (!running || !available()) { clear(); return; }
      if (now - last < 1000 / 30) { frame = requestAnimationFrame(draw); return; }
      const dt = Math.min((now - last) / 1000, .1); last = now;
      context.clearRect(0, 0, width, height);
      const ground = terminal.options.theme?.background ?? "#000000";
      // Dug holes hide the text beneath them with ragged, dirt-lined edges.
      const hole = (h: Hole, depth: number) => {
        const left = Math.max(0, h.start) * cellWidth, right = Math.min(terminal.cols, h.end) * cellWidth, top = h.row * cellHeight;
        if (right <= left) return;
        context.fillStyle = ground; context.fillRect(left, top, right - left, cellHeight * depth);
        context.fillStyle = "#7a5a36";
        for (let px = left; px < right; px += 3) {
          const bite = ((Math.floor(px) * 7 + h.row * 13) % 5) / 5;
          context.fillRect(px, top + cellHeight * depth - 2 - bite * 2, 2, 2);
          if (bite > .5) context.fillRect(px, top, 2, 2);
        }
        context.fillRect(left, top, 2, cellHeight * depth); context.fillRect(right - 2, top, 2, cellHeight * depth);
      };
      holes.forEach(h => hole(h, 1));
      for (let i = 0; i < tuxes.length; i++) {
        const tux = tuxes[i];
        if (motion.matches) { tux.x = terminal.cols / 2; tux.y = terminal.rows; tux.state = "walk"; }
        else stepTux(tux, dt, platforms, terminal.rows, Math.random, holes, terminal.cols);
        if (tux.wait > 0) continue;
        const pixel = pixelSize();
        const size = pixel * 16;
        const digProgress = tux.state === "dig" ? Math.min(1, tux.age / DIG_TIME) : 0;
        // Sink in steps, one per scoop, with a small wobble while digging.
        const scoop = Math.floor(tux.age * 6) % 4;
        const sink = Math.min(1, Math.floor(digProgress * 5) / 5 + (scoop === 1 ? .06 : 0));
        const hammering = tux.state === "dig" && tux.tool === "jackhammer";
        // The jackhammer shakes Tux quickly; the shovel only rocks him with each scoop.
        const wobble = tux.state !== "dig" ? 0 : hammering ? (Math.floor(now / 45) % 2 ? 1 : -1) * Math.max(1, cellWidth / 10) : (scoop === 1 ? 1 : scoop === 3 ? -1 : 0) * Math.max(1, cellWidth / 8);
        const x = tux.x * cellWidth + wobble, y = (tux.y + (tux.state === "dig" ? sink : 0)) * cellHeight + (hammering && Math.floor(now / 60) % 2 ? Math.max(1, cellHeight / 16) : 0);
        const sprite = motion.matches ? (Math.floor(now / 180) % 24 === 0 ? view.blink : view.stand) : tux.sliding ? view.slide : tux.state === "fall" ? (tux.vy > 2 ? (Math.floor(now / 90) % 2 ? view.flapUp : view.flapDown) : view.fall) : tux.state === "dig" ? (hammering ? view.stand : (tux.age % .75) / .75 < .35 ? view.digDown : view.digUp) : tux.state === "exit" && tux.leave >= 0 && tux.leave <= LEAVE.wave ? (Math.floor(tux.leave * 5) % 2 ? view.wave : view.stand) : tux.state === "walk" || tux.state === "exit" ? (Math.floor(tux.age * (tux.state === "exit" ? 12 : 7)) % 2 ? view.sideA : view.sideB) : view.wave;
        const hidden = tux.state === "gone" || (tux.state === "exit" && tux.leave > LEAVE.wave + LEAVE.slip);
        if (tux.state === "dig") hole(digSpan(tux), sink);
        const corner = () => {
          if (tux.state !== "exit" || tux.leave < 0) return;
          const edge = tux.direction > 0 ? width : 0;
          const full = size * 1.3, t = tux.leave;
          // The corner opens slowly while Tux waves, stays open while he slips behind it, then closes.
          const flap = t < LEAVE.wave ? full * (t / LEAVE.wave) : t < LEAVE.wave + LEAVE.slip ? full : full * Math.max(0, 1 - (t - LEAVE.wave - LEAVE.slip) / LEAVE.close);
          if (flap <= 0) return;
          context.fillStyle = "#243746"; context.beginPath(); context.moveTo(edge, height); context.lineTo(edge - tux.direction * flap, height); context.lineTo(edge, height - flap); context.closePath(); context.fill();
          context.strokeStyle = "#8baab6"; context.stroke();
        };
        const waving = tux.state === "exit" && tux.leave >= 0 && tux.leave <= LEAVE.wave;
        if (waving) corner();
        if (!hidden) {
        context.save(); context.translate(x, y - size);
        context.scale(tux.direction, 1);
        const paint = (rows: string[]) => rows.forEach((row, sy) => [...row].forEach((color, sx) => { if (tuxPalette[color]) { context.fillStyle = color === "k" || color === "-" ? tux.color : tuxPalette[color]; context.fillRect((sx - 8) * pixel, sy * pixel, pixel, pixel); } }));
        paint(sprite);
        if (tux.state === "dig") {
          paint(helmet);
          // Tools in sprite space (facing right, mirrored by the transform): origin = sprite centre, y down from the top.
          if (hammering) {
            // Front view: the jackhammer stands in front of the belly.
            const jx = -1.5 * pixel, chisel = Math.floor(now / 45) % 2 ? 0 : pixel;
            context.fillStyle = "#59636b"; context.fillRect(jx - pixel, 6 * pixel, 5 * pixel, pixel);
            context.fillStyle = "#9aa5ad"; context.fillRect(jx, 7 * pixel, 3 * pixel, 7 * pixel);
            context.fillStyle = "#d94f2a"; context.fillRect(jx, 9 * pixel, 3 * pixel, pixel);
            context.fillStyle = "#cfd6db"; context.fillRect(jx + pixel, 14 * pixel, pixel, 2 * pixel + chisel);
          } else {
            // Front view, sideways shovelling: stab into the ground in front, then swing the
            // loaded blade out to one side; the side alternates with every stroke.
            const stroke = .75, t = (tux.age % stroke) / stroke, side = Math.floor(tux.age / stroke) % 2 ? 1 : -1;
            const ease = (v: number) => 1 - (1 - v) * (1 - v);
            const angle = t < .35 ? side * -1.9 * (1 - ease(t / .35)) : side * 1.9 * ease((t - .35) / .65);
            const push = t < .35 ? Math.round(ease(t / .35)) * pixel : 0;
            const gx = 0, gy = 9 * pixel + push, dx = Math.sin(angle), dy = Math.cos(angle);
            context.fillStyle = "#8a5a2b";
            for (let i = 0; i <= 7; i++) context.fillRect(gx + dx * i * pixel - pixel / 2, gy + dy * i * pixel - pixel / 2, pixel, pixel);
            const bx = gx + dx * 8.5 * pixel, by = gy + dy * 8.5 * pixel;
            context.save(); context.translate(bx, by); context.rotate(-angle);
            context.fillStyle = "#9aa5ad"; context.fillRect(-1.5 * pixel, -pixel, 3 * pixel, 3 * pixel);
            if (t >= .35 && t < .9) { context.fillStyle = "#7a5a36"; context.fillRect(-pixel, -2 * pixel, 2 * pixel, pixel); }
            context.restore();
          }
        }
        context.restore();
        }
        if (tux.state === "dig") {
          // Dirt and letters from the dug line fly off in arcs to both sides.
          const span = digSpan(tux), text = lines[tux.floor] ?? "", unit = cellHeight / 16, groundY = tux.floor * cellHeight;
          const letters = text.slice(Math.max(0, span.start), Math.max(0, span.end)).replace(/\s/g, "");
          context.font = `bold ${Math.round(cellHeight * .8)}px monospace`; context.textAlign = "center"; context.textBaseline = "middle";
          for (let p = 0; p < 14; p++) {
            const phase = (tux.age * 1.6 + p / 14) % 1;
            if (tux.age < p / 14 / 1.6) continue;
            const side = p % 2 ? 1 : -1, speed = 22 + (p * 37) % 26, lift = 46 + (p * 53) % 34;
            const px = x + side * speed * phase * unit * 3, py = groundY - lift * phase * unit * 2 + 120 * phase * phase * unit * 2;
            if (p % 3 === 0 && letters) {
              context.save(); context.translate(px, py); context.rotate(side * phase * 6);
              context.globalAlpha = 1 - phase * .6; context.fillStyle = "#d8dee9";
              context.fillText(letters[(p + Math.floor(tux.age * 3)) % letters.length], 0, 0); context.restore();
            } else {
              context.fillStyle = ["#c4a67d", "#8a6b45", "#6b4f2e"][p % 3]; context.globalAlpha = 1 - phase * .5;
              const bit = Math.max(2, Math.round(unit * (2 + (p % 2))));
              context.fillRect(px, py, bit, bit); context.globalAlpha = 1;
            }
          }
          context.globalAlpha = 1;
          if (digProgress > .75) {
            // Dust puffs at the rim as the hole breaks through.
            const puff = (digProgress - .75) / .25;
            context.fillStyle = `rgba(196,166,125,${.45 * (1 - puff)})`;
            for (const edge of [span.start, span.end]) { context.beginPath(); context.arc(edge * cellWidth, groundY + cellHeight * .5, cellHeight * (.3 + puff * .9), 0, Math.PI * 2); context.fill(); }
          }
        }
        if (!waving) corner();
        if (tux.state === "gone") {
          tuxes[i] = createTux(MARGIN + Math.random() * Math.max(0, terminal.cols - 2 * MARGIN), Math.random() < .5 ? -1 : 1, 1 + Math.random() * 4, randomColor());
        }
      }
      // Retro action: starts once per idle phase some seconds after the Tuxes arrived, drawn above them.
      if (!motion.matches) {
        runTime += dt;
        if (!scene && runTime >= actionAt) beginAction();
        if (scene && plan) {
          scene.step(dt);
          context.save(); context.scale(plan.stage.scale, plan.stage.scale); drawScene(context, scene, plan, ground); context.restore();
          if (scene.done || scene.time > SCENE_TIMEOUT) { scene = null; plan = null; }
        }
      }
      // Reduced motion needs only occasional blink updates, no continuous RAF loop.
      if (motion.matches) timer = setTimeout(() => { frame = requestAnimationFrame(draw); }, 180);
      else frame = requestAnimationFrame(draw);
    };
    const start = () => {
      clear(); if (!available()) return;
      const screen = target.querySelector<HTMLElement>(".xterm-screen") ?? target;
      width = screen.clientWidth; height = screen.clientHeight;
      if (!width || !height) return;
      surface.style.left = `${screen.offsetLeft}px`; surface.style.top = `${screen.offsetTop}px`;
      surface.style.width = `${width}px`; surface.style.height = `${height}px`;
      const ratio = window.devicePixelRatio || 1;
      surface.width = Math.round(width * ratio); surface.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.imageSmoothingEnabled = false;
      cellWidth = width / terminal.cols; cellHeight = height / terminal.rows;
      lines = Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(false) ?? "");
      platforms = platformsFromLines(lines);
      holes = [];
      tuxes = Array.from({ length: motion.matches ? 1 : count }, (_, index) => createTux(MARGIN + Math.random() * Math.max(0, terminal.cols - 2 * MARGIN), Math.random() < .5 ? -1 : 1, index * (.6 + Math.random() * 1.2), index === 0 ? (bodyColor ?? TUX_COLORS[0]) : randomColor()));
      runTime = 0; actionAt = retro && gate.available && actionsAllowed({ enabled, reducedMotion: motion.matches, design: retro }) ? actionDelay(Math.random) : Infinity;
      running = true; last = performance.now(); frame = requestAnimationFrame(draw);
    };
    const schedule = () => { clearTimeout(timer); if (enabled && available()) timer = setTimeout(start, clock.remaining(performance.now(), minutes * 60000)); };
    const activity = () => { clear(); gate.arm(); clock.activity(performance.now()); schedule(); };
    const visibility = () => { clear(); gate.arm(); clock.activity(performance.now()); schedule(); };
    const test = () => { if (active) { gate.arm(); start(); } };
    const events = ["tux-activity", "keydown", "pointerdown", "paste", "input", "wheel"];
    events.forEach(event => target.addEventListener(event, activity, true));
    const input = terminal.onData(activity);
    const output = terminal.onWriteParsed(activity);
    const scroll = terminal.onScroll(activity);
    const resize = new ResizeObserver(activity); resize.observe(target);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener(tuxTestEvent, test);
    motion.addEventListener("change", activity);
    schedule();
    return () => { clear(); input.dispose(); output.dispose(); scroll.dispose(); resize.disconnect(); events.forEach(event => target.removeEventListener(event, activity, true)); document.removeEventListener("visibilitychange", visibility); window.removeEventListener(tuxTestEvent, test); motion.removeEventListener("change", activity); };
  }, [terminal, enabled, minutes, count, visible, active, retro]);
  return <canvas ref={canvas} aria-hidden="true" style={{ position: "absolute", pointerEvents: "none", zIndex: 3 }} />;
}
