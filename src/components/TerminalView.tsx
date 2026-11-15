import { keyringErrorText } from "../lib/keyringErrors";
import { errorText } from "../lib/backendError";
import { terminalNotice } from "../lib/terminalNotice";
import { useT } from "../i18n";
import { readClipboardText, writeClipboardText } from "../lib/clipboard";
import { parseSerialPermission, serialFixCommands, type SerialPermission } from "../lib/serialPermission";
import { TuxOverlay } from "./TuxOverlay";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { readTerminal, exportText, exportHtml, exportRtf } from "../lib/terminalExport";
import { localTimestamp, startLog, stopLog, terminalPasteRequests } from "../lib/sessionLog";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Channel, killPty, resizePty, spawnPty, writePty } from "../lib/pty";
import { answerHostKey, answerSecret, cancelSshConnect, closeSsh, connectSsh, resizeSsh, writeSsh, type SshPrompt } from "../lib/ssh";
import { parseOsc7, type TerminalCwd } from "../lib/osc7";
import { parseQuickConnect } from "../lib/quickConnect";
import { createPromptCommandSender } from "../lib/promptCommand";
import { accumulateZoomWheel, effectiveFontSize, initialZoomWheel, nextZoomOffset, offsetAfterResetToken } from "../lib/fontZoom";

import { selectedTheme, type Settings } from "../lib/settings";
import { emojiFallback } from "../lib/terminalThemes";

import { inputProvenance, terminalWriters } from "../lib/multiExec";
import { MonitorBar } from "./MonitorBar";

interface Props {
  /** Changes whenever "Schrift Standard" is chosen; clears this tab's zoom offset. */
  fontResetToken?: number;
  onSerialPermission(id: number, info: SerialPermission): void;
  logPath?: string;
  connected?: boolean;
  onLogToggle(id: number): void;
  title: string;
  logAlways?: boolean;
  onLog(id: number, path: string | null): void;
  visible?: boolean;
  paneStyle?: React.CSSProperties;
  onFocusPane?: () => void;
  monitoringSession?: number;
  onInput?: (id: number, data: string, pasted: boolean) => void;
  gridFooter?: React.ReactNode;
  exited?: boolean;
  preferences: Settings;
  id: number;
  serial?: import("../lib/sessions").SerialConfig | null;
  kind: "local" | "wsl" | "ssh" | "telnet" | "serial";
  target?: string;
  savedSessionId?: string;
  startCommand?: import("../lib/pty").StartCommand;
  active: boolean;
  shellIntegration: boolean;
  sshPromptCommand: boolean;
  onExit: (id: number) => void;
  onCloseTab?: (id: number) => void;
  onRestart?: (id: number) => void;
  onStatus: (message: string) => void;
  onSession: (id: number, sessionId: number | null) => void;
  onCwd: (id: number, cwd: TerminalCwd) => void;
  onPrompt: (id: number, prompt: SshPrompt) => void;
  onClearPrompts: (id: number) => void;
}
let nextConnectToken = 1;
interface Runtime { terminal: Terminal; fit: FitAddon }

export function TerminalView({ fontResetToken, onSerialPermission, serial, logPath, connected, onLogToggle, title, logAlways, onLog, paneStyle, onFocusPane, visible, monitoringSession, onInput, gridFooter, exited: processExited, preferences, id, kind, target, savedSessionId, startCommand, active, shellIntegration, sshPromptCommand, onExit, onCloseTab, onRestart, onStatus, onSession, onCwd, onPrompt, onClearPrompts }: Props) {
  const t = useT();
  const [tuxTerminal, setTuxTerminal] = useState<Terminal | null>(null);
  const logRef = useRef({ title, logAlways, onLog }); logRef.current = { title, logAlways, onLog };
  const [pasteMenu, setPasteMenu] = useState<{ x: number; y: number } | null>(null);
  const [exportMenu, setExportMenu] = useState(false);
  const pasteMenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = pasteMenuRef.current;
    if (!pasteMenu || !menu) return;
    const place = () => {
      menu.style.left = `${Math.max(0, Math.min(pasteMenu.x, window.innerWidth - menu.offsetWidth))}px`;
      menu.style.top = `${Math.max(0, Math.min(pasteMenu.y, window.innerHeight - menu.offsetHeight))}px`;
    };
    place(); window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [pasteMenu, exportMenu]);
  useEffect(() => {
    if (!pasteMenu) return;
    pasteMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (event: PointerEvent) => { if (!pasteMenuRef.current?.contains(event.target as Node)) setPasteMenu(null); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [pasteMenu, exportMenu]);
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const wireSession = useRef<number | undefined>(undefined);
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  const inputRef = useRef(onInput); inputRef.current = onInput;
  const shownRef = useRef(visible ?? active); shownRef.current = visible ?? active;
  const activeRef = useRef(active);
  activeRef.current = active;
  const callbacks = useRef({ onSerialPermission, onExit, onCloseTab, onRestart, onStatus, onSession, onCwd, onPrompt, onClearPrompts, saveOutput: (): void => undefined });
  callbacks.current = { onSerialPermission, onExit, onCloseTab, onRestart, onStatus, onSession, onCwd, onPrompt, onClearPrompts, saveOutput: () => { void saveContent("txt"); } };
  const settings = useRef({ shellIntegration, sshPromptCommand });
  settings.current = { shellIntegration, sshPromptCommand };
  // Per-tab font size offset against the settings; memory only, ends with the tab.
  const zoomRef = useRef(0);
  const [zoomOffset, setZoomOffset] = useState(0);
  const applyZoom = (offset: number) => {
    zoomRef.current = offset; setZoomOffset(offset);
    const current = runtime.current;
    if (!current) return;
    const size = effectiveFontSize(preferencesRef.current.fontSize, offset);
    current.terminal.options.fontSize = size;
    // Several steps within one frame lead to a single fit (and PTY resize).
    if (fitFrame.current === undefined) fitFrame.current = requestAnimationFrame(() => {
      fitFrame.current = undefined;
      if (shownRef.current) runtime.current?.fit.fit();
    });
    callbacks.current.onStatus(t("terminal.fontSize", { size }));
  };
  const applyZoomRef = useRef(applyZoom); applyZoomRef.current = applyZoom;
  const fitFrame = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (fitFrame.current !== undefined) cancelAnimationFrame(fitFrame.current); fitFrame.current = undefined; }, []);
  const seenResetToken = useRef(fontResetToken ?? 0);
  useEffect(() => {
    const next = offsetAfterResetToken(seenResetToken.current, fontResetToken ?? 0, zoomRef.current);
    seenResetToken.current = next.seen;
    if (next.offset !== zoomRef.current) applyZoomRef.current(next.offset);
  }, [fontResetToken]);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    // StrictMode's probe cleanup cancels this task before any PTY is spawned.
    queueMicrotask(() => {
      const element = container.current;
      if (cancelled || !element) return;
      const initial = preferencesRef.current;
      const terminal = new Terminal({ fontFamily: initial.fontFamily + emojiFallback, fontSize: effectiveFontSize(initial.fontSize, zoomRef.current), lineHeight: initial.lineHeight, cursorStyle: initial.cursorStyle, cursorBlink: initial.cursorBlink, scrollback: initial.scrollback, theme: selectedTheme(initial) });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element);
      runtime.current = { terminal, fit };
      setTuxTerminal(terminal);
      const permissionShell = kind === "local" && serialFixCommands.has(id);
      let shellReady = false;
      let permissionReadyTimer: ReturnType<typeof setTimeout> | undefined;
      let sessionId: number | undefined;
      const connectToken = nextConnectToken++ >>> 0;
      let connecting = kind === "ssh" || kind === "telnet";
      let exited = false;
      const wire = kind === "telnet" || kind === "serial";
      const write = wire ? (id: number, data: string) => invoke<void>("terminal_write", { id, data }) : kind === "ssh" ? writeSsh : writePty;
      const resizeSession = wire ? (id: number, cols: number, rows: number) => invoke<void>("terminal_resize", { id, cols, rows }) : kind === "ssh" ? resizeSsh : resizePty;
      const close = wire ? (id: number) => invoke<void>("terminal_close", { id }) : kind === "ssh" ? closeSsh : killPty;
      const report = (error: unknown) => callbacks.current.onStatus(t("terminal.error", { message: keyringErrorText(error) }));
      const promptCommand = createPromptCommandSender(() => kind === "ssh" && settings.current.sshPromptCommand && !cancelled && !exited, write, report, () => ({ cols: terminal.cols, cursorX: terminal.buffer.active.cursorX }), () => {
        const buffer = terminal.buffer.active;
        if (buffer.type === "alternate") return "blocked";
        const line = (buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(false, 0, buffer.cursorX) ?? "").trimEnd();
        if (/[:?]$/.test(line)) return "blocked";
        return /[$#%>❯]$/.test(line) ? "prompt" : "other";
      });
      const sendPermissionCommand = () => {
        if (!permissionShell || !shellReady || sessionId === undefined || cancelled || exited) return;
        const pending = serialFixCommands.get(id);
        if (!pending) return;
        serialFixCommands.delete(id);
        clearTimeout(permissionReadyTimer);
        void write(sessionId, pending.command + "\r").then(() => {
          pending.resolve();
          requestAnimationFrame(() => terminal.focus());
        }, pending.reject);
      };
      if (permissionShell) permissionReadyTimer = setTimeout(() => {
        const pending = serialFixCommands.get(id);
        if (pending) {
          serialFixCommands.delete(id);
          pending.reject(new Error(t("terminal.shellNotReady")));
        }
      }, 15000);
      const permissionReady = terminal.parser.registerOscHandler(777, payload => {
        if (!permissionShell || payload !== "werkterm-serial-ready") return false;
        shellReady = true;
        sendPermissionCommand();
        return true;
      });
      const osc = terminal.parser.registerOscHandler(7, payload => {
        const cwd = parseOsc7(payload, kind === "local" && /Windows/i.test(navigator.userAgent));
        if (!cwd) return false;
        if (!cancelled && !wire) callbacks.current.onCwd(id, cwd);
        return true;
      });
      const fitVisible = () => { if (!cancelled && shownRef.current && element.clientWidth > 0 && element.clientHeight > 0) fit.fit(); };
      const send = (data: string) => { terminal.element?.dispatchEvent(new Event("tux-activity")); if (sessionId !== undefined && !exited && !cancelled) void write(sessionId, data).catch(report); };
      const provenance = inputProvenance(terminal);
      let keyboardInput = false;
      let deliveringPaste = false;
      const copySelection = (automatic = false) => {
        const text = terminal.getSelection();
        if (text) void writeClipboardText(text).catch(error => { if (!automatic) report(error); });
      };
      let selectionTimer: ReturnType<typeof setTimeout> | undefined;
      const selection = terminal.onSelectionChange(() => {
        clearTimeout(selectionTimer);
        if (preferencesRef.current.copyOnSelect && terminal.getSelection()) selectionTimer = setTimeout(() => {
          if (preferencesRef.current.copyOnSelect && !cancelled) copySelection(true);
        }, 150);
      });
      terminal.attachCustomKeyEventHandler(event => {
        // After the session ended: Return closes the tab, R restarts, S saves the output.
        if (exited && !event.ctrlKey && !event.altKey && !event.metaKey) {
          const key = event.key.toLowerCase();
          if (key === "enter" || key === "r" || key === "s") {
            event.preventDefault();
            if (event.type === "keydown") {
              if (key === "enter") callbacks.current.onCloseTab?.(id);
              else if (key === "r") callbacks.current.onRestart?.(id);
              else callbacks.current.saveOutput();
            }
            return false;
          }
        }
        if (!event.altKey && ((event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c") || (event.ctrlKey && event.key === "Insert"))) {
          event.preventDefault();
          if (event.type === "keydown") copySelection();
          return false;
        }
        if (!event.altKey && (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") || (event.shiftKey && event.key === "Insert"))) {
          event.preventDefault();
          if (event.type === "keydown") terminalPasteRequests.get(id)?.();
          return false;
        }
        keyboardInput = true; return true;
      });
      // Ctrl+wheel / pinch (arrives as wheel with ctrlKey): zoom this terminal only. Capture phase plus
      // stopPropagation keeps xterm from scrolling or sending mouse-wheel reports to the application.
      let zoomWheel = initialZoomWheel;
      const zoom = (event: WheelEvent) => {
        if (!event.ctrlKey) return;
        event.preventDefault(); event.stopPropagation();
        const result = accumulateZoomWheel(zoomWheel, event.deltaY, event.deltaMode, event.timeStamp);
        zoomWheel = result.state;
        if (result.steps !== 0) applyZoomRef.current(nextZoomOffset(preferencesRef.current.fontSize, zoomRef.current, result.steps));
      };
      element.addEventListener("wheel", zoom, { capture: true, passive: false });
      const markTextInput = () => { keyboardInput = true; };
      const markOtherInput = () => { keyboardInput = false; };
      const textEvents = ["compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"];
      const otherEvents = ["mousedown", "mouseup", "mousemove", "wheel", "focusout"];
      textEvents.forEach(type => element.addEventListener(type, markTextInput, true));
      otherEvents.forEach(type => element.addEventListener(type, markOtherInput, true));
      const canDistribute = () => !permissionShell && shownRef.current && element.contains(document.activeElement);
      const requestPaste = (text: string) => { if (permissionShell) { terminal.paste(text); return; } if (!cancelled && !exited && inputRef.current) inputRef.current(id, text, true); };
      terminalPasteRequests.set(id, () => { void readClipboardText().then(requestPaste).catch(report); });
      const paste = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData("text/plain");
        if (text === undefined) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        requestPaste(text);
      };
      element.addEventListener("paste", paste, true);
      const input = terminal.onData(data => {
        if (provenance.isUserInput()) promptCommand.userInput();
        if (!deliveringPaste && provenance.isUserInput() && keyboardInput && canDistribute() && inputRef.current) inputRef.current(id, data, false);
        else send(data);
      });
      const resize = terminal.onResize(({ cols, rows }) => { if (sessionId !== undefined && !exited) void resizeSession(sessionId, cols, rows).catch(report); });
      const observer = new ResizeObserver(fitVisible);
      observer.observe(element);
      const onData = new Channel<ArrayBuffer>();
      onData.onmessage = buffer => {
        if (cancelled) return;
        const notice = terminalNotice(buffer);
        if (notice !== null) { terminal.write(notice); return; }
        terminal.element?.dispatchEvent(new Event("tux-activity"));
        terminal.write(new Uint8Array(buffer));
        promptCommand.receiveData();
      };
      const onExitChannel = new Channel<number | null>();
      onExitChannel.onmessage = () => { if (!cancelled && !exited) {
        const pending = serialFixCommands.get(id);
        if (pending) { serialFixCommands.delete(id); pending.reject(new Error(t("terminal.shellExited"))); }
        clearTimeout(permissionReadyTimer);
        exited = true; logRef.current.onLog(id, null); terminalWriters.delete(id); if (kind === "ssh" || wire) callbacks.current.onStatus(t("terminal.connectionEnded")); terminal.write(`\r\n\r\n\x1b[1;33m${t("terminal.ended.title")}\x1b[0m\r\n    - \x1b[1m<Return>\x1b[0m: ${t("terminal.ended.close")}\r\n    - \x1b[1mR\x1b[0m: ${t("terminal.ended.restart")}\r\n    - \x1b[1mS\x1b[0m: ${t("terminal.ended.save")}\r\n`); callbacks.current.onSession(id, null); callbacks.current.onExit(id); } };
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
      const dimensions = { tabId: id, cols: terminal.cols, rows: terminal.rows, onData, onExit: onExitChannel };
      const spawned = (async () => {
        if (!permissionShell && (preferencesRef.current.logAllSessions || logRef.current.logAlways)) {
          try { const path = await startLog(id, logRef.current.title, preferencesRef.current); if (!cancelled) logRef.current.onLog(id, path); }
          catch (error) { report(error); }
        }
        if (cancelled) { await stopLog(id).catch(report); return undefined; }
        if (kind === "serial") return invoke<number>("serial_connect", { ...dimensions, config: serial });
        if (kind === "telnet") {
          const parsed = parseQuickConnect(target ?? "");
          if (!parsed) throw new Error(t("terminal.invalidTelnet"));
          return invoke<number>("telnet_connect", { ...dimensions, host: parsed.host, port: parsed.port, connectToken });
        }
        return kind === "ssh"
        ? connectSsh({ ...dimensions, target: target ?? "", sessionId: savedSessionId ?? null, connectToken, onPrompt: onPromptChannel })
        : spawnPty({ ...dimensions, kind, startCommand, serialPermissionShell: permissionShell, shellIntegration: settings.current.shellIntegration });
      })();
      void spawned.then(result => {
        connecting = false;
        if (result === undefined) return;
        const spawnedId = typeof result === "number" ? result : result.id;
        if (cancelled) { void close(spawnedId).catch(() => undefined); return; }
        sessionId = spawnedId; wireSession.current = spawnedId;
        callbacks.current.onClearPrompts(id);
        const destination = parseQuickConnect(target ?? "");
        if (typeof result !== "number" && !exited) callbacks.current.onStatus(t("terminal.connected", { target: destination ? `${destination.user}@${destination.host}` : target ?? "", mode: result.mode }));
        if (!exited) {
          if (!permissionShell) terminalWriters.set(id, (data, pasted) => {
            // MultiExec input bypasses xterm's own scroll-on-input, so jump to the end here.
            terminal.scrollToBottom();
            if (!pasted) { send(data); return; }
            // xterm.paste emits onData synchronously. Do not redistribute that
            // approved paste through the keyboard/MultiExec path a second time.
            deliveringPaste = true;
            try { terminal.paste(data); } finally { deliveringPaste = false; }
          });
          sendPermissionCommand();
          callbacks.current.onSession(id, spawnedId);
          void resizeSession(spawnedId, terminal.cols, terminal.rows).catch(report);
          promptCommand.connect(spawnedId);
        }
      }).catch((error: unknown) => {
        connecting = false;
        callbacks.current.onClearPrompts(id);
        if (cancelled) return;
        const permission = kind === "serial" ? parseSerialPermission(error) : null;
        if (permission) callbacks.current.onSerialPermission(id, permission);
        const pending = serialFixCommands.get(id);
        if (pending) { serialFixCommands.delete(id); pending.reject(error); }
        exited = true;
        void stopLog(id).catch(report); logRef.current.onLog(id, null);
        terminal.write(`\r\n\x1b[31m${kind === "ssh" ? t("terminal.failed.ssh") : wire ? t("terminal.failed.wire") : t("terminal.failed.pty")}: ${keyringErrorText(error).replace(/[\x00-\x1f\x7f]/g, " ")}\x1b[0m\r\n`);
        callbacks.current.onSession(id, null);
        callbacks.current.onExit(id);
        report(error);
      });
      cleanup = () => {
        clearTimeout(permissionReadyTimer);
        const pending = serialFixCommands.get(id);
        if (pending) { serialFixCommands.delete(id); pending.reject(new Error(t("terminal.closed"))); }
        callbacks.current.onClearPrompts(id);
        if (connecting) void (kind === "telnet" ? invoke<void>("terminal_cancel_connect", { connectToken }) : cancelSshConnect(connectToken)).catch(() => undefined);
        terminalPasteRequests.delete(id);
        if (sessionId === undefined) void stopLog(id).catch(report);
        logRef.current.onLog(id, null);
        element.removeEventListener("paste", paste, true);
        element.removeEventListener("wheel", zoom, { capture: true });
        textEvents.forEach(type => element.removeEventListener(type, markTextInput, true));
        otherEvents.forEach(type => element.removeEventListener(type, markOtherInput, true));
        terminalWriters.delete(id);
        clearTimeout(selectionTimer); selection.dispose();
        provenance.dispose(); observer.disconnect(); input.dispose(); resize.dispose(); osc.dispose(); permissionReady.dispose(); promptCommand.dispose();
        onData.onmessage = () => undefined;
        onExitChannel.onmessage = () => undefined;
        onPromptChannel.onmessage = rejectPrompt;
        if (sessionId !== undefined) void close(sessionId).catch(() => undefined);
        runtime.current = null; wireSession.current = undefined;
        terminal.dispose();
      };
    });
    return () => { cancelled = true; cleanup?.(); };
  }, [id, kind, target, savedSessionId, startCommand]);

  useEffect(() => {
    const current = runtime.current;
    if (!current) return;
    Object.assign(current.terminal.options, { fontFamily: preferences.fontFamily + emojiFallback, fontSize: effectiveFontSize(preferences.fontSize, zoomRef.current), lineHeight: preferences.lineHeight, cursorStyle: preferences.cursorStyle, cursorBlink: preferences.cursorBlink, scrollback: preferences.scrollback, theme: selectedTheme(preferences) });
    if (shownRef.current) current.fit.fit();
  }, [preferences]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { runtime.current?.fit.fit(); runtime.current?.terminal.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => { if (visible ?? active) { const frame = requestAnimationFrame(() => runtime.current?.fit.fit()); return () => cancelAnimationFrame(frame); } }, [visible, active, monitoringSession, gridFooter]);

  const closeMenu = () => { setPasteMenu(null); setExportMenu(false); runtime.current?.terminal.focus(); };
  const copy = (all: boolean) => {
    const terminal = runtime.current?.terminal;
    if (!terminal) return;
    const text = all ? exportText(readTerminal(terminal.buffer.active, terminal.options.theme), /Windows/i.test(navigator.userAgent)) : terminal.getSelection();
    if (all || text) void writeClipboardText(text).catch(error => onStatus(t("terminal.copyError", { message: errorText(error) })));
    closeMenu();
  };
  const saveContent = async (format: "txt" | "html" | "rtf") => {
    const terminal = runtime.current?.terminal;
    if (!terminal) return;
    closeMenu();
    try {
      const doc = readTerminal(terminal.buffer.active, terminal.options.theme, terminal.options.fontFamily);
      const name = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 100) || t("terminal.defaultName");
      const path = await save({ defaultPath: `${name}_${localTimestamp()}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
      if (path) {
        const contents = format === "txt" ? exportText(doc, /Windows/i.test(navigator.userAgent)) : format === "html" ? exportHtml(doc, title) : exportRtf(doc);
        await invoke("save_text_file", { path, contents });
        onStatus(t("terminal.saved", { path }));
      }
    } catch (error) { onStatus(t("terminal.exportError", { message: errorText(error) })); }
  };
  return <section style={paneStyle} onPointerDown={onFocusPane} onContextMenu={event => {
    event.preventDefault();
    if (preferencesRef.current.rightClick === "paste" && !event.shiftKey) { terminalPasteRequests.get(id)?.(); return; }
    setExportMenu(false); setPasteMenu({ x: event.clientX, y: event.clientY });
  }} id={`terminal-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} className={`terminal-panel ${active ? "is-active" : ""} ${processExited ? "is-exited" : ""}`} hidden={!(visible ?? active)}>
    <div style={{ position: "relative", flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}><div className="terminal-container" ref={container} style={{ height: "100%" }} /><TuxOverlay terminal={tuxTerminal} enabled={preferences.tuxEnabled} minutes={preferences.tuxIdleMinutes} count={preferences.tuxCount} visible={visible ?? active} active={active} /></div>{monitoringSession !== undefined && <MonitorBar sessionId={monitoringSession} />}{gridFooter}
    {pasteMenu && <div ref={pasteMenuRef} role="menu" aria-label={t("terminal.actions")} className="session-context" style={{ left: pasteMenu.x, top: pasteMenu.y, maxHeight: "100vh", maxWidth: "100vw", overflowY: "auto" }} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); event.stopPropagation();
        const buttons = Array.from(pasteMenuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    }}>
      {exportMenu ? <>{(["txt", "html", "rtf"] as const).map(format => <button key={format} role="menuitem" onClick={() => { void saveContent(format); }}>{t("terminal.saveAs", { format: format.toUpperCase() })}</button>)}<button role="menuitem" onClick={() => setExportMenu(false)}>{t("terminal.back")}</button></> : <>
        {kind === "serial" && <button role="menuitem" disabled={processExited || !connected} onClick={() => { void invoke("serial_break", { id: wireSession.current }).catch(error => onStatus(errorText(error))); closeMenu(); }}>{t("terminal.break")}</button>}
        <button role="menuitem" disabled={!runtime.current?.terminal.getSelection()} onClick={() => copy(false)}>{t("terminal.copy")}</button>
        <button role="menuitem" disabled={processExited} onClick={() => { closeMenu(); terminalPasteRequests.get(id)?.(); }}>{t("terminal.paste")}</button>
        <button role="menuitem" onClick={() => { runtime.current?.terminal.selectAll(); closeMenu(); }}>{t("terminal.selectAll")}</button>
        <button role="menuitem" onClick={() => copy(true)}>{t("terminal.copyAll")}</button>
        <button role="menuitem" aria-haspopup="menu" onClick={() => setExportMenu(true)}>{t("terminal.saveContent")}</button>
        <button role="menuitem" onClick={() => { runtime.current?.terminal.clear(); closeMenu(); }}>{t("terminal.clear")}</button>
        {zoomOffset !== 0 && <button role="menuitem" onClick={() => { closeMenu(); applyZoom(0); }}>{t("terminal.resetFont")}</button>}
        <button role="menuitem" disabled={processExited || !connected} onClick={() => { onLogToggle(id); closeMenu(); }}>{logPath ? t("menu.terminal.logStop") : t("menu.terminal.logStart")}</button>
      </>}
    </div>}
  </section>;
}
