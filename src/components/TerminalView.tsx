import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Channel, killPty, resizePty, spawnPty, writePty } from "../lib/pty";
import { answerHostKey, answerSecret, cancelSshConnect, closeSsh, connectSsh, resizeSsh, writeSsh, type SshPrompt } from "../lib/ssh";
import { parseOsc7, type TerminalCwd } from "../lib/osc7";
import { parseQuickConnect } from "../lib/quickConnect";
import { createPromptCommandSender } from "../lib/promptCommand";

import { selectedTheme, type Settings } from "../lib/settings";
import { emojiFallback } from "../lib/terminalThemes";

interface Props {
  preferences: Settings;
  id: number;
  kind: "local" | "wsl" | "ssh";
  target?: string;
  savedSessionId?: string;
  active: boolean;
  shellIntegration: boolean;
  sshPromptCommand: boolean;
  onExit: (id: number) => void;
  onStatus: (message: string) => void;
  onSession: (id: number, sessionId: number | null) => void;
  onCwd: (id: number, cwd: TerminalCwd) => void;
  onPrompt: (id: number, prompt: SshPrompt) => void;
  onClearPrompts: (id: number) => void;
}
let nextConnectToken = 1;
interface Runtime { terminal: Terminal; fit: FitAddon }

export function TerminalView({ preferences, id, kind, target, savedSessionId, active, shellIntegration, sshPromptCommand, onExit, onStatus, onSession, onCwd, onPrompt, onClearPrompts }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  const activeRef = useRef(active);
  activeRef.current = active;
  const callbacks = useRef({ onExit, onStatus, onSession, onCwd, onPrompt, onClearPrompts });
  callbacks.current = { onExit, onStatus, onSession, onCwd, onPrompt, onClearPrompts };
  const settings = useRef({ shellIntegration, sshPromptCommand });
  settings.current = { shellIntegration, sshPromptCommand };

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    // StrictMode's probe cleanup cancels this task before any PTY is spawned.
    queueMicrotask(() => {
      const element = container.current;
      if (cancelled || !element) return;
      const initial = preferencesRef.current;
      const terminal = new Terminal({ fontFamily: initial.fontFamily + emojiFallback, fontSize: initial.fontSize, lineHeight: initial.lineHeight, cursorStyle: initial.cursorStyle, cursorBlink: initial.cursorBlink, scrollback: initial.scrollback, theme: selectedTheme(initial) });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element);
      runtime.current = { terminal, fit };
      let sessionId: number | undefined;
      const connectToken = nextConnectToken++ >>> 0;
      let connecting = kind === "ssh";
      let exited = false;
      const write = kind === "ssh" ? writeSsh : writePty;
      const resizeSession = kind === "ssh" ? resizeSsh : resizePty;
      const close = kind === "ssh" ? closeSsh : killPty;
      const report = (error: unknown) => callbacks.current.onStatus(`Terminal: ${String(error)}`);
      const promptCommand = createPromptCommandSender(() => kind === "ssh" && settings.current.sshPromptCommand && !cancelled && !exited, write, report, () => ({ cols: terminal.cols, cursorX: terminal.buffer.active.cursorX }));
      const osc = terminal.parser.registerOscHandler(7, payload => {
        const cwd = parseOsc7(payload, kind === "local" && /Windows/i.test(navigator.userAgent));
        if (!cwd) return false;
        if (!cancelled) callbacks.current.onCwd(id, cwd);
        return true;
      });
      const fitVisible = () => { if (!cancelled && activeRef.current && element.clientWidth > 0 && element.clientHeight > 0) fit.fit(); };
      const input = terminal.onData(data => { if (sessionId !== undefined && !exited) void write(sessionId, data).catch(report); });
      const resize = terminal.onResize(({ cols, rows }) => { if (sessionId !== undefined && !exited) void resizeSession(sessionId, cols, rows).catch(report); });
      const observer = new ResizeObserver(fitVisible);
      observer.observe(element);
      const onData = new Channel<ArrayBuffer>();
      onData.onmessage = buffer => {
        if (cancelled) return;
        terminal.write(new Uint8Array(buffer));
        promptCommand.receiveData();
      };
      const onExitChannel = new Channel<number | null>();
      onExitChannel.onmessage = () => { if (!cancelled && !exited) { exited = true; if (kind === "ssh") callbacks.current.onStatus("SSH-Verbindung beendet"); terminal.write("\r\n[Prozess beendet]"); callbacks.current.onSession(id, null); callbacks.current.onExit(id); } };
      const onPromptChannel = new Channel<SshPrompt>();
      const rejectPrompt = (prompt: SshPrompt) => {
        void (prompt.type === "hostKey" ? answerHostKey(prompt.requestId, false) : answerSecret(prompt.requestId, null)).catch(() => undefined);
      };
      onPromptChannel.onmessage = prompt => {
        if (cancelled) rejectPrompt(prompt);
        else callbacks.current.onPrompt(id, prompt);
      };
      fitVisible();
      if (activeRef.current) terminal.focus();
      const dimensions = { cols: terminal.cols, rows: terminal.rows, onData, onExit: onExitChannel };
      const spawned = kind === "ssh"
        ? connectSsh({ ...dimensions, target: target ?? "", sessionId: savedSessionId ?? null, connectToken, onPrompt: onPromptChannel })
        : spawnPty({ ...dimensions, kind, shellIntegration: settings.current.shellIntegration });
      void spawned.then(result => {
        connecting = false;
        const spawnedId = typeof result === "number" ? result : result.id;
        if (cancelled) { void close(spawnedId).catch(() => undefined); return; }
        sessionId = spawnedId;
        callbacks.current.onClearPrompts(id);
        const destination = parseQuickConnect(target ?? "");
        if (typeof result !== "number" && !exited) callbacks.current.onStatus(`Verbunden mit ${destination ? `${destination.user}@${destination.host}` : target ?? ""} (${result.mode})`);
        if (!exited) {
          callbacks.current.onSession(id, spawnedId);
          void resizeSession(spawnedId, terminal.cols, terminal.rows).catch(report);
          promptCommand.connect(spawnedId);
        }
      }).catch((error: unknown) => {
        connecting = false;
        callbacks.current.onClearPrompts(id);
        if (cancelled) return;
        exited = true;
        terminal.write(`\r\n\x1b[31m${kind === "ssh" ? "SSH-Verbindung fehlgeschlagen" : "PTY konnte nicht gestartet werden"}: ${String(error).replace(/[\x00-\x1f\x7f]/g, " ")}\x1b[0m\r\n`);
        callbacks.current.onSession(id, null);
        callbacks.current.onExit(id);
        report(error);
      });
      cleanup = () => {
        callbacks.current.onClearPrompts(id);
        if (connecting) void cancelSshConnect(connectToken).catch(() => undefined);
        observer.disconnect(); input.dispose(); resize.dispose(); osc.dispose(); promptCommand.dispose();
        onData.onmessage = () => undefined;
        onExitChannel.onmessage = () => undefined;
        onPromptChannel.onmessage = rejectPrompt;
        if (sessionId !== undefined) void close(sessionId).catch(() => undefined);
        runtime.current = null;
        terminal.dispose();
      };
    });
    return () => { cancelled = true; cleanup?.(); };
  }, [id, kind, target, savedSessionId]);

  useEffect(() => {
    const current = runtime.current;
    if (!current) return;
    Object.assign(current.terminal.options, { fontFamily: preferences.fontFamily + emojiFallback, fontSize: preferences.fontSize, lineHeight: preferences.lineHeight, cursorStyle: preferences.cursorStyle, cursorBlink: preferences.cursorBlink, scrollback: preferences.scrollback, theme: selectedTheme(preferences) });
    if (activeRef.current) current.fit.fit();
  }, [preferences]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { runtime.current?.fit.fit(); runtime.current?.terminal.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return <section id={`terminal-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} className={`terminal-panel ${active ? "is-active" : ""}`} hidden={!active}><div className="terminal-container" ref={container} /></section>;
}
