import { useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Channel, killPty, resizePty, spawnPty, writePty, type ShellKind } from "../lib/pty";

interface Props { id: number; kind: ShellKind; active: boolean; onExit: (id: number) => void; onStatus: (message: string) => void }
interface Runtime { terminal: Terminal; fit: FitAddon }

function terminalTheme(styles: CSSStyleDeclaration): ITheme {
  const color = (name: string) => styles.getPropertyValue(`--term-${name}`).trim();
  return {
    background: color("bg"), foreground: color("fg"), cursor: color("cursor"), selectionBackground: color("selection"),
    black: color("black"), red: color("red"), green: color("green"), yellow: color("yellow"), blue: color("blue"), magenta: color("magenta"), cyan: color("cyan"), white: color("white"),
    brightBlack: color("bright-black"), brightRed: color("bright-red"), brightGreen: color("bright-green"), brightYellow: color("bright-yellow"), brightBlue: color("bright-blue"), brightMagenta: color("bright-magenta"), brightCyan: color("bright-cyan"), brightWhite: color("bright-white"),
  };
}

export function TerminalView({ id, kind, active, onExit, onStatus }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const callbacks = useRef({ onExit, onStatus });
  callbacks.current = { onExit, onStatus };

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    // StrictMode's probe cleanup cancels this task before any PTY is spawned.
    queueMicrotask(() => {
      const element = container.current;
      if (cancelled || !element) return;
      const styles = getComputedStyle(element);
      const terminal = new Terminal({ cursorBlink: true, fontFamily: styles.getPropertyValue("--font-mono").trim(), fontSize: parseFloat(styles.getPropertyValue("--font-size-term")), theme: terminalTheme(styles) });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element);
      runtime.current = { terminal, fit };
      let sessionId: number | undefined;
      let exited = false;
      const report = (error: unknown) => callbacks.current.onStatus(`Terminal: ${String(error)}`);
      const fitVisible = () => { if (!cancelled && activeRef.current && element.clientWidth > 0 && element.clientHeight > 0) fit.fit(); };
      const input = terminal.onData(data => { if (sessionId !== undefined && !exited) void writePty(sessionId, data).catch(report); });
      const resize = terminal.onResize(({ cols, rows }) => { if (sessionId !== undefined && !exited) void resizePty(sessionId, cols, rows).catch(report); });
      const observer = new ResizeObserver(fitVisible);
      observer.observe(element);
      const onData = new Channel<ArrayBuffer>();
      onData.onmessage = buffer => { if (!cancelled) terminal.write(new Uint8Array(buffer)); };
      const onExitChannel = new Channel<number | null>();
      onExitChannel.onmessage = () => { if (!cancelled && !exited) { exited = true; terminal.write("\r\n[Prozess beendet]"); callbacks.current.onExit(id); } };
      fitVisible();
      if (activeRef.current) terminal.focus();
      void spawnPty({ kind, cols: terminal.cols, rows: terminal.rows, onData, onExit: onExitChannel }).then(spawnedId => {
        if (cancelled) { void killPty(spawnedId).catch(() => undefined); return; }
        sessionId = spawnedId;
        if (!exited) void resizePty(spawnedId, terminal.cols, terminal.rows).catch(report);
      }).catch((error: unknown) => {
        if (cancelled) return;
        exited = true;
        terminal.write(`\r\n\x1b[31mPTY konnte nicht gestartet werden: ${String(error).replace(/[\x00-\x1f\x7f]/g, " ")}\x1b[0m\r\n`);
        callbacks.current.onExit(id);
        report(error);
      });
      cleanup = () => {
        observer.disconnect(); input.dispose(); resize.dispose();
        onData.onmessage = () => undefined;
        onExitChannel.onmessage = () => undefined;
        if (sessionId !== undefined) void killPty(sessionId).catch(() => undefined);
        runtime.current = null;
        terminal.dispose();
      };
    });
    return () => { cancelled = true; cleanup?.(); };
  }, [id, kind]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { runtime.current?.fit.fit(); runtime.current?.terminal.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return <section id={`terminal-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} className={`terminal-panel ${active ? "is-active" : ""}`} hidden={!active}><div className="terminal-container" ref={container} /></section>;
}
