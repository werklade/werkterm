import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { createTux, digSpan, IdleClock, LEAVE, platformsFromLines, stepTux, type Hole } from "../lib/tux/simulation";
import { palette, sprites } from "../lib/tux/sprites";

export const tuxTestEvent = "werkterm:tux-test";
export function TuxOverlay({ terminal, enabled, minutes, count, visible, active }: { terminal: Terminal | null; enabled: boolean; minutes: number; count: number; visible: boolean; active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
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
    let platforms = platformsFromLines([]);
    let holes: Hole[] = [];
    let width = 0, height = 0, cellWidth = 0, cellHeight = 0;
    const available = () => visible && document.visibilityState === "visible" && target.getClientRects().length > 0 && target.clientWidth > 0 && target.clientHeight > 0;
    const clear = () => { running = false; cancelAnimationFrame(frame); clearTimeout(timer); context.clearRect(0, 0, surface.width, surface.height); };
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
        const pixel = Math.max(1, Math.floor(cellHeight * 2 / 16));
        const size = pixel * 16;
        const x = tux.x * cellWidth, y = (tux.y + (tux.state === "dig" ? Math.min(1, tux.age / .9) : 0)) * cellHeight;
        const sprite = motion.matches ? (Math.floor(now / 180) % 24 === 0 ? sprites.blink : sprites.stand) : tux.state === "fall" ? sprites.fall : tux.state === "dig" ? sprites.dig : tux.state === "exit" && tux.leave >= 0 && tux.leave <= LEAVE.wave ? (Math.floor(tux.leave * 5) % 2 ? sprites.wave : sprites.stand) : tux.state === "walk" || tux.state === "exit" ? (Math.floor(tux.age * (tux.state === "exit" ? 12 : 7)) % 2 ? sprites.walk1 : sprites.walk2) : sprites.wave;
        const hidden = tux.state === "gone" || (tux.state === "exit" && tux.leave > LEAVE.wave + LEAVE.slip);
        if (tux.state === "dig") hole(digSpan(tux), Math.min(1, tux.age / .9));
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
        sprite.forEach((row, sy) => [...row].forEach((color, sx) => { if (palette[color]) { context.fillStyle = palette[color]; context.fillRect((sx - 8) * pixel, sy * pixel, pixel, pixel); } }));
        context.restore();
        }
        if (tux.state === "dig") {
          context.fillStyle = "#c4a67d";
          for (let p = 0; p < 7; p++) { const phase = (tux.age * 3 + p / 7) % 1; context.fillRect(x + (p - 3) * phase * 13, y - Math.sin(phase * Math.PI) * 16, 3, 3); }
        }
        if (!waving) corner();
        if (tux.state === "gone") {
          tuxes[i] = createTux(Math.random() * terminal.cols, Math.random() < .5 ? -1 : 1, 1 + Math.random() * 4);
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
      platforms = platformsFromLines(Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(false) ?? ""));
      holes = [];
      tuxes = Array.from({ length: motion.matches ? 1 : count }, (_, index) => createTux(Math.random() * terminal.cols, Math.random() < .5 ? -1 : 1, index * (.6 + Math.random() * 1.2)));
      running = true; last = performance.now(); frame = requestAnimationFrame(draw);
    };
    const schedule = () => { clearTimeout(timer); if (enabled && available()) timer = setTimeout(start, clock.remaining(performance.now(), minutes * 60000)); };
    const activity = () => { clear(); clock.activity(performance.now()); schedule(); };
    const visibility = () => { clear(); clock.activity(performance.now()); schedule(); };
    const test = () => { if (active) start(); };
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
  }, [terminal, enabled, minutes, count, visible, active]);
  return <canvas ref={canvas} aria-hidden="true" style={{ position: "absolute", pointerEvents: "none", zIndex: 3 }} />;
}
