import { connectionTitle, connectionStatus } from "./lib/connection";
import { defaultSerial } from "./lib/sessions";
import { tuxTestEvent } from "./components/TuxOverlay";
import { TunnelDialog, TunnelConfirmDialog } from "./components/TunnelDialog";
import { isLoopback, type Tunnel, type TunnelStatus } from "./lib/tunnels";
import { listen } from "@tauri-apps/api/event";
import { SshCloseDialog } from "./components/SshCloseDialog";
import { activeSshTabs, shouldConfirmSsh, closeAfterSsh } from "./lib/sshClose";
import { shouldFocusMenu } from "./lib/menu";
import { SplitLayout, paneStyle, useSplitRatios } from "./components/SplitLayout";
import { assignPane, cleanPanes, paneCount, seedPanes, type SplitMode } from "./lib/split";
import { ToolDialog } from "./components/ToolDialog";
import { Home } from "./components/Home";
import { createMenus } from "./lib/actions";
import { recentList, lastTabsList, terminalDescriptors, type Recent, type LastTab } from "./lib/history";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { SettingsDialog } from "./components/SettingsDialog";
import { HelpDialog } from "./components/HelpDialog";
import { ImportDialog } from "./components/ImportDialog";
import { normalizeSettings, selectedTheme } from "./lib/settings";
import { MenuBar } from "./components/MenuBar";
import { Toolbar } from "./components/Toolbar";
import { Sidebar, type BrowserTab } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { SecretDialog } from "./components/SecretDialog";
import { SessionDialog } from "./components/SessionDialog";
import { SessionUserDialog } from "./components/SessionUserDialog";
import { jumpHostHint, listSessions, sessionTarget, type SavedSession } from "./lib/sessions";
import { availableShells, type ShellKind } from "./lib/pty";
import { answerHostKey, answerSecret, type SshPrompt } from "./lib/ssh";
import { loadSettings, saveSettings, type Settings } from "./lib/settings";
import { parseQuickConnect } from "./lib/quickConnect";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { beginClose, advanceClose, type CloseAnswer } from "./lib/editorClose";
import { invoke, Channel } from "@tauri-apps/api/core";
import { allocateTransferId, cancelTransfer, downloadFile, uploadFile, type TransferProgress } from "./lib/transfers";
import { TransferQueue, type QueueState, type ConflictResolution } from "./lib/transferQueue";
import { FileActionDialog, type FileDialog } from "./components/FileActionDialog";
import type { EditorDocument } from "./lib/editorTypes";
import type { EditorHandle } from "./components/EditorView";
import { parentPath } from "./lib/paths";
import { browserForEditor, editorFileKey, sourceForEditorOpen } from "./lib/tabSources";
import { useModal } from "./components/useModal";
import "./styles/theme.css";
import "./App.css";
import { PasteDialog } from "./components/PasteDialog";
import { shouldConfirmPaste } from "./lib/paste";
import { defaultLogFolder, openLogFolder, startLog, stopLog, terminalPasteRequests } from "./lib/sessionLog";
import { gridColumns, inputTargets, terminalWriters } from "./lib/multiExec";

const TerminalView = lazy(() => import("./components/TerminalView").then(module => ({ default: module.TerminalView })));

const EditorView = lazy(() => import("./components/EditorView"));
interface EditorTabState { document: EditorDocument; source: BrowserTab; sourceKey: string; dirty: boolean; status: string }
function EditorCloseDialog({ name, busy, onAnswer }: { name: string; busy: boolean; onAnswer: (answer: "save" | "discard" | "cancel") => void }) {
  const modal = useModal();
  useEffect(() => {
    if (!busy) modal.current?.querySelector<HTMLButtonElement>("[autofocus]")?.focus();
  }, [busy, modal]);
  return <dialog ref={modal} className="ssh-dialog" aria-modal="true" aria-labelledby="editor-close-title" onCancel={event => { event.preventDefault(); if (!busy) onAnswer("cancel"); }}>
    <h2 id="editor-close-title">Ungespeicherte Änderungen</h2><p>Änderungen an „{name}“ speichern?</p>
    <div className="dialog-actions"><button disabled={busy} onClick={() => onAnswer("save")}>Speichern</button><button disabled={busy} onClick={() => onAnswer("discard")}>Verwerfen</button><button autoFocus disabled={busy} onClick={() => onAnswer("cancel")}>Abbrechen</button></div>
  </dialog>;
}
function editorOpenError(reason: unknown): string {
  const message = String(reason);
  const errors: Record<string, string> = { ENCODING: "Die Datei ist nicht als UTF-8 kodiert.", BINARY: "Binärdateien können nicht im Editor geöffnet werden.", TOO_LARGE: "Die Datei ist für den Editor zu groß.", SESSION_CLOSED: "Die SSH-Sitzung wurde beendet. Der Editorinhalt bleibt erhalten.", CONFLICT: "Die Datei wurde außerhalb des Editors geändert." };
  return errors[message.split(":", 1)[0]] ?? `Datei konnte nicht geöffnet werden: ${message}`;
}

interface QueuedPrompt { tabId: number; prompt: SshPrompt }
function localTitle() { return /Windows/i.test(navigator.userAgent) ? "PowerShell" : "Shell"; }
function declinePrompt(prompt: SshPrompt) {
  return prompt.type === "hostKey" ? answerHostKey(prompt.requestId, false) : answerSecret(prompt.requestId, null);
}

export default function App() {
  const [tool, setTool] = useState<"ascii" | "ports" | "keygen" | null>(null);
  const [panes, setPanes] = useState<(number | null)[]>([]);
  const [focusedPane, setFocusedPane] = useState(0);
  const [ratios, setRatios] = useSplitRatios();
  const [multiExec, setMultiExec] = useState(false);
  const beforeMultiExec = useRef<number | null>(null);
  const [unchecked, setUnchecked] = useState<Set<number>>(() => new Set());
  const [pasteRequest, setPasteRequest] = useState<{ targets: number[]; data: string; multiExec: boolean } | null>(null);
  const [logPaths, setLogPaths] = useState<Record<number, string>>({});
  const logBusy = useRef(new Set<number>());
  const onLog = useCallback((id: number, path: string | null) => setLogPaths(current => { const next = { ...current }; if (path) next[id] = path; else delete next[id]; return next; }), []);
  useEffect(() => {
    const subscription = listen<{ id: number; message: string }>("session-log-error", event => {
      setStatus(event.payload.message); onLog(event.payload.id, null);
    });
    return () => { void subscription.then(stop => stop()); };
  }, [onLog]);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [editors, setEditors] = useState<Record<number, EditorTabState>>({});
  const editorsRef = useRef(editors);
  editorsRef.current = editors;
  const editorHandles = useRef(new Map<number, EditorHandle>());
  const pendingOpens = useRef(new Map<string, Promise<void>>());
  const closing = useRef(new Set<number>());
  const windowClosing = useRef(false);
  const closeAnswer = useRef<((answer: CloseAnswer) => void) | null>(null);
  const closeRequest = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(event => {
      // Prevent synchronously; destruction is requested only after the sequence succeeds.
      event.preventDefault();
      void closeRequest.current();
    }).then(stop => { if (disposed) stop(); else unlisten = stop; })
      .catch(reason => setStatus(String(reason)));
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const [sshClose, setSshClose] = useState<{ message: string; transfers: number; quitting: boolean; answer(accepted: boolean, never: boolean): void } | null>(null);
  const [closeEditorId, setCloseEditorId] = useState<number | null>(null);
  const [closeEditorBusy, setCloseEditorBusy] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(0);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [hasWsl, setHasWsl] = useState(false);
  const [shellsLoaded, setShellsLoaded] = useState(false);
  const [transfer, setTransfer] = useState<QueueState>(null);
  const [tunnelConfirmation, setTunnelConfirmation] = useState<((accepted: boolean) => void) | null>(null);
  const [tunnelsOpen, setTunnelsOpen] = useState(false);
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [tunnelStatuses, setTunnelStatuses] = useState<TunnelStatus[]>([]);
  const tunnelAutostart = useRef(false);
  const activeTunnels = tunnelStatuses.filter(s => ["running", "connecting", "reconnecting"].includes(s.state)).length;
  const reloadTunnels = async () => { setTunnels(await invoke<Tunnel[]>("tunnels_list")); setTunnelStatuses(await invoke<TunnelStatus[]>("tunnel_list_status")); };
  const tunnelPromptChannel = () => { const channel = new Channel<SshPrompt>(); channel.onmessage = prompt => queuePrompt(-1, prompt); return channel; };
  const startTunnel = async (t: Tunnel) => {
    const allowPublic = !isLoopback(t.bind_address) ? await new Promise<boolean>(resolve => setTunnelConfirmation(() => resolve)) : false;
    if (!isLoopback(t.bind_address) && !allowPublic) return;
    await invoke("tunnel_start", { id: t.id, allowPublic, onPrompt: tunnelPromptChannel() });
  };
  useEffect(() => {
    let disposed = false;
    const subscription = listen<TunnelStatus>("tunnel-status", event => { if (!disposed) setTunnelStatuses(current => [...current.filter(s => s.id !== event.payload.id), event.payload]); });
    void subscription.then(async () => {
      if (disposed) return;
      await reloadTunnels();
      if (!tunnelAutostart.current) { tunnelAutostart.current = true; await invoke("tunnel_autostart", { onPrompt: tunnelPromptChannel() }); }
    }).catch(reason => setStatus(String(reason)));
    return () => { disposed = true; void subscription.then(unlisten => unlisten()); };
  }, []);
  const [status, setStatus] = useState("Bereit");
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [sessionDialog, setSessionDialog] = useState<{ session?: SavedSession; tabId?: number; preferPassword?: boolean } | null>(null);
  const [userSession, setUserSession] = useState<SavedSession | null>(null);
  const [quickUserTarget, setQuickUserTarget] = useState<string | null>(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const reloadSessions = useCallback(() => { void listSessions().then(items => { setSavedSessions(items); setSessionsLoaded(true); }).catch(() => setStatus("Gespeicherte Sitzungen konnten nicht geladen werden.")); }, []);
  useEffect(reloadSessions, [reloadSessions]);
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => {
    void defaultLogFolder().then(logFolder => {
      if (!settingsRef.current.logFolder) changeSettings({ ...settingsRef.current, logFolder });
    }).catch(reason => setStatus(`Protokollordner: ${String(reason)}`));
  }, []);
  const sidebarVisible = settings.sidebarVisible;
  const setSidebarVisible = (value: boolean | ((current: boolean) => boolean)) => changeSettings({ ...settingsRef.current, sidebarVisible: typeof value === "function" ? value(settingsRef.current.sidebarVisible) : value });
  const [temporaryMenu, setTemporaryMenu] = useState(false);
  const [shellName, setShellName] = useState(localTitle);
  const [recents, setRecents] = useState<Recent[]>([]);
  const [lastTabs, setLastTabs] = useState<LastTab[]>([]);
  const [restoreQueue, setRestoreQueue] = useState<LastTab[] | null>(null);
  useEffect(() => {
    void recentList().then(setRecents).catch(reason => setStatus(String(reason)));
    void lastTabsList().then(setLastTabs).catch(reason => setStatus(String(reason)));
    void invoke<string>("local_shell_name").then(setShellName).catch(reason => setStatus(String(reason)));
  }, []);
  useEffect(() => {
    const show = (event: KeyboardEvent) => {
      if (shouldFocusMenu(event, !!(document.activeElement?.closest(".terminal-panel, .xterm, .editor-view, .cm-editor"))) && !document.querySelector("dialog[open]")) {
        setTemporaryMenu(true);
        requestAnimationFrame(() => document.querySelector<HTMLElement>('.menubar [data-top="0"]')?.focus());
      }
      if (event.key === "Escape") setTemporaryMenu(false);
    };
    const outside = (event: PointerEvent) => { if (!(event.target instanceof Element && event.target.closest(".menubar"))) setTemporaryMenu(false); };
    document.addEventListener("keydown", show, true);
    document.addEventListener("pointerdown", outside, true);
    return () => { document.removeEventListener("keydown", show, true); document.removeEventListener("pointerdown", outside, true); };
  }, []);
  const [sidebarPanel, setSidebarPanel] = useState(3);
  // Every switch to a tab other than Home shows the SSH browser for that tab.
  useEffect(() => {
    if (activeId !== null && activeId !== 0) setSidebarPanel(3);
  }, [activeId]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [help, setHelp] = useState<"about" | "shortcuts" | null>(null);
  const [importSource, setImportSource] = useState<"mobaxterm" | "windterm" | null>(null);
  const fullscreenPending = useRef(false);
  useEffect(() => { document.documentElement.style.setProperty("--bg-content", selectedTheme(settings).background); }, [settings]);
  const [prompts, setPrompts] = useState<QueuedPrompt[]>([]);
  const promptQueue = useRef<QueuedPrompt[]>([]);
  const liveTabs = useRef(new Set<number>());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const nextId = useRef(1);
  const sessions = useRef(new Map<number, number>());
  const sshTabs = useRef(new Set<number>());
  const [conflict, setConflict] = useState<FileDialog | null>(null);
  const [conflictSequence, setConflictSequence] = useState(0);
  const [transferQueue] = useState(() => new TransferQueue({
    download: downloadFile,
    upload: uploadFile,
    cancel: cancelTransfer,
    allocateId: allocateTransferId,
    createChannel: (update: (progress: TransferProgress) => void) => new Channel<TransferProgress>(update),
    report: setStatus,
    resolveConflict: (name: string, signal: AbortSignal) => new Promise<ConflictResolution>(resolve => {
      let answered = false;
      const finish = (answer: ConflictResolution) => {
        if (answered) return;
        answered = true;
        signal.removeEventListener("abort", abort);
        setConflict(null);
        resolve(answer);
      };
      const abort = () => finish("cancel");
      if (signal.aborted) { finish("cancel"); return; }
      signal.addEventListener("abort", abort, { once: true });
      setConflictSequence(value => value + 1);
      setConflict({ type: "conflict", name, answer: answer => finish(answer === "all" ? "overwriteAll" : answer) });
    }),
  }));
  useEffect(() => transferQueue.subscribe(setTransfer), [transferQueue]);
  useEffect(() => transferQueue.onFinished(event => {
    if (event.cancelled) setStatus("Transfer abgebrochen");
    else if (event.error === undefined) setStatus(event.kind === "upload" ? "Upload abgeschlossen" : "Download abgeschlossen");
  }), [transferQueue]);
  useEffect(() => () => {
    for (const sessionId of sessions.current.values()) transferQueue.cancelSession(sessionId);
  }, [transferQueue]);
  const cancelTabTransfers = useCallback((id: number) => {
    const sessionId = sessions.current.get(id);
    if (sessionId !== undefined) transferQueue.cancelSession(sessionId);
    sessions.current.delete(id);
    sshTabs.current.delete(id);
  }, [transferQueue]);

  useEffect(() => {
    let cancelled = false;
    void availableShells().then(shells => { if (!cancelled) { setHasWsl(shells.includes("wsl")); setShellsLoaded(true); } }).catch((error: unknown) => {
      if (!cancelled) setStatus(`Verfügbare Shells konnten nicht geladen werden: ${String(error)}`);
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => () => {
    for (const item of promptQueue.current) void declinePrompt(item.prompt).catch(() => undefined);
    promptQueue.current = [];
  }, []);

  const removePrompts = useCallback((id: number) => {
    const removed = promptQueue.current.filter(item => item.tabId === id);
    promptQueue.current = promptQueue.current.filter(item => item.tabId !== id);
    setPrompts([...promptQueue.current]);
    for (const item of removed) void declinePrompt(item.prompt).catch(() => undefined);
  }, []);
  const openTab = (kind: ShellKind, startCommand?: import("./lib/pty").StartCommand) => {
    if (windowClosing.current) return;
    const id = nextId.current++;
    liveTabs.current.add(id);
    setTabs(current => [...current, { id, kind, startCommand, title: startCommand ? ({ root: "Root", processes: "Prozesse", hardware: "Hardware" }[startCommand]) : (kind === "wsl" ? "WSL" : shellName), exited: false, browserPath: "" }]);
    setActiveId(id);
  };
  const connect = (target: string) => {
    if (windowClosing.current) return;
    const parsed = parseQuickConnect(target);
    if (!parsed) return;
    if (!parsed.kind && !parsed.user) { setQuickUserTarget(target.trim()); return; }
    const id = nextId.current++;
    liveTabs.current.add(id);
    sshTabs.current.add(id);
    setTabs(current => [...current, { id, kind: parsed.kind ?? "ssh", serial: parsed.kind === "serial" ? { ...defaultSerial, device: parsed.host, baud: parsed.baud ?? 115200 } : undefined, target: target.trim(), title: connectionTitle(parsed.kind ?? "ssh", target, parsed.kind === "serial" ? { ...defaultSerial, device: parsed.host, baud: parsed.baud ?? 115200 } : undefined), exited: false, browserPath: "" }]);
    setActiveId(id);
    setStatus(`Verbinde mit ${connectionTitle(parsed.kind ?? "ssh", target, parsed.kind === "serial" ? { ...defaultSerial, device: parsed.host, baud: parsed.baud ?? 115200 } : undefined)}…`);
  };
  const connectSaved = (session: SavedSession, userOverride?: string) => {
    if (windowClosing.current) return;
    if (session.kind === "ssh" && !session.user && !userOverride) { setUserSession(session); return; }
    const id = nextId.current++;
    liveTabs.current.add(id);
    sshTabs.current.add(id);
    setTabs(current => [...current, { id, kind: session.kind as "ssh" | "telnet" | "serial", serial: session.serial, target: sessionTarget(session, userOverride), savedSessionId: session.id, title: session.name, exited: false, browserPath: "" }]);
    setActiveId(id);
    setStatus(`Verbinde mit ${session.name}…`);
  };
  useEffect(() => {
    if (restoreQueue === null || userSession || quickUserTarget || windowClosing.current) return;
    if (tabs.some(t => t.kind === "ssh" && !t.exited && t.sessionId === undefined)) return;
    if (!restoreQueue.length) { setRestoreQueue(null); return; }
    const [tab, ...remaining] = restoreQueue;
    setRestoreQueue(remaining);
    if (tab.type === "local" || tab.type === "wsl") { if (tab.type === "local" || hasWsl) openTab(tab.type); }
    else if (tab.type === "saved") { const session = savedSessions.find(s => s.id === tab.sessionId); if (session) connectSaved(session); }
    else if (tab.type === "quick") connect(tab.target);
  });
  const reportStatus = (message: string) => {
    setStatus(message);
    const id = activeIdRef.current;
    if (id !== null) setEditors(current => !current[id] ? current : { ...current, [id]: { ...current[id], status: message } });
  };
  const removeTab = (id: number) => {
    cancelTabTransfers(id);
    liveTabs.current.delete(id);
    removePrompts(id);
    const currentTabs = tabsRef.current;
    const index = currentTabs.findIndex(tab => tab.id === id);
    if (currentTabs[index]?.kind === "ssh" && currentTabs[index]?.sessionId === undefined && !currentTabs[index]?.exited) setStatus("Verbindungsaufbau abgebrochen");
    if (activeIdRef.current === id) setActiveId(currentTabs[index + 1]?.id ?? currentTabs[index - 1]?.id ?? 0);
    setTabs(current => current.filter(tab => tab.id !== id));
  };
  const askEditorClose = (id: number): Promise<CloseAnswer> => {
    setActiveId(id); setCloseEditorId(id);
    return new Promise(resolve => { closeAnswer.current = resolve; });
  };
  const finishEditorClose = async (id: number) => {
    const editor = editorsRef.current[id];
    if (!editor) return;
    await invoke("editor_close", { docId: editor.document.docId });
    const next = { ...editorsRef.current }; delete next[id];
    editorsRef.current = next; setEditors(next);
    editorHandles.current.delete(id);
    removeTab(id);
  };
  const closeEditors = async (ids: number[], remove: boolean): Promise<boolean> => {
    let state = beginClose(ids);
    while (state.phase === "pending") {
      const id = state.remaining[0];
      const editor = editorsRef.current[id];
      const handle = editorHandles.current.get(id);
      if (!editor || !handle) throw new Error("Editor ist noch nicht bereit.");
      // Hold the lock across the final dirty check, dialog, save and editor_close.
      await handle.lock();
      try {
        const answer = handle.isDirty() ? await askEditorClose(id) : "discard";
        setCloseEditorBusy(true);
        const saved = answer !== "save" || (await handle.save() && !handle.isDirty());
        state = advanceClose(state, answer, saved);
        if (state.phase === "cancelled") return false;
        if (remove) await finishEditorClose(id);
      } finally {
        handle.unlock();
        setCloseEditorBusy(false); setCloseEditorId(null); closeAnswer.current = null;
      }
    }
    return true;
  };
  const askSshClose = async (ids?: number[]): Promise<boolean> => {
    const candidates = tabsRef.current.filter(tab => !ids || ids.includes(tab.id));
    const tunnelCount = ids ? 0 : (await invoke<TunnelStatus[]>("tunnel_list_status").catch(() => tunnelStatuses)).filter(s => ["running", "connecting", "reconnecting"].includes(s.state)).length;
    if (!shouldConfirmSsh(candidates, settingsRef.current.confirmCloseSsh) && !(tunnelCount && settingsRef.current.confirmCloseSsh)) return true;
    const active = activeSshTabs(candidates);
    const transfers = active.reduce((count, tab) => count + (tab.kind === "ssh" ? transferQueue.countSession(tab.sessionId!) : 0), 0);
    const destination = active[0] ? connectionTitle(active[0].kind, active[0].target ?? "", active[0].serial) : "Verbindung";
    const message = ids ? `Verbindung zu ${destination} ist aktiv. Wirklich trennen?` : `${active.length} aktive Verbindung(en) werden getrennt und ${tunnelCount} Tunnel werden gestoppt. Beenden?`;
    return new Promise(resolve => setSshClose({ message, transfers, quitting: !ids, answer: (accepted, never) => {
      if (never) changeSettings({ ...settingsRef.current, confirmCloseSsh: false });
      setSshClose(null); resolve(accepted);
    } }));
  };
  const closeTab = (id: number) => {
    if (id === 0 || windowClosing.current || closing.current.size) return;
    closing.current.add(id);
    void closeAfterSsh(() => askSshClose([id]), async () => {
      if (editorsRef.current[id]) return closeEditors([id], true);
      removeTab(id); return true;
    }).catch(reason => reportStatus(String(reason))).finally(() => closing.current.delete(id));
  };
  const answerEditorClose = (answer: CloseAnswer) => {
    if (closeEditorBusy) return;
    const resolve = closeAnswer.current;
    closeAnswer.current = null;
    resolve?.(answer);
  };
  closeRequest.current = async () => {
    if (windowClosing.current || closing.current.size) return;
    windowClosing.current = true;
    const locked: EditorHandle[] = [];
    try {
      const approved = await closeAfterSsh(() => askSshClose(), async () => {
        await Promise.all(pendingOpens.current.values());
        // Freeze every document so a clean tab cannot become dirty mid-sequence.
        for (const handle of [...editorHandles.current.values()]) { locked.push(handle); await handle.lock(); }
        return closeEditors(Object.keys(editorsRef.current).map(Number), false);
      });
      if (approved) {
        const restore = terminalDescriptors(tabsRef.current);
        await invoke("last_tabs_save", { tabs: restore });
        await Promise.all(tabsRef.current.filter(tab => tab.kind !== "editor").map(tab => stopLog(tab.id)));
        await getCurrentWindow().destroy();
      }
    } catch (reason) { reportStatus("Fenster konnte nicht geschlossen werden: " + String(reason)); }
    finally { for (const handle of locked) handle.unlock(); windowClosing.current = false; }
  };
  const openEditor = (browserSource: BrowserTab, path: string) => {
    if (windowClosing.current) return;
    const source = sourceForEditorOpen(browserSource, editorsRef.current[browserSource.id]?.source);
    if (["editor", "telnet", "serial"].includes(source.kind)) return;
    const sourceKey = editorFileKey(source, path);
    const existing = Object.entries(editorsRef.current).find(([, editor]) => editor.sourceKey === sourceKey);
    if (existing) { setActiveId(Number(existing[0])); return; }
    if (pendingOpens.current.has(sourceKey)) return;
    const pending = (async () => {
      try {
        const document = await (source.kind === "ssh"
          ? invoke<EditorDocument>("editor_open_remote", { id: source.sessionId, path })
          : invoke<EditorDocument>("editor_open_local", { path, wslDistro: source.kind === "wsl" ? source.cwd?.host ?? null : null }));
        const id = nextId.current++;
        const editor: EditorTabState = { document, source: { ...source, browserPath: parentPath(path) }, sourceKey, dirty: false, status: "Editor" };
        editorsRef.current = { ...editorsRef.current, [id]: editor };
        setEditors(editorsRef.current);
        setTabs(current => [...current, { id, kind: "editor", title: document.name, browserPath: parentPath(path), exited: false }]);
        setActiveId(id);
      } catch (reason: unknown) { reportStatus(editorOpenError(reason)); }
      finally { pendingOpens.current.delete(sourceKey); }
    })();
    pendingOpens.current.set(sourceKey, pending);
  };
  const markExited = useCallback((id: number) => {
    cancelTabTransfers(id);
    liveTabs.current.delete(id);
    removePrompts(id);
    setTabs(current => current.map(tab => tab.id === id ? { ...tab, exited: true, sessionId: undefined } : tab));
  }, [removePrompts, cancelTabTransfers]);
  const setSession = useCallback((id: number, sessionId: number | null) => {
    if (sessionId === null) cancelTabTransfers(id);
    else if (liveTabs.current.has(id) && sshTabs.current.has(id)) {
      const tab = tabsRef.current.find(t => t.id === id);
      if (tab?.kind === "ssh") sessions.current.set(id, sessionId);
      if (tab) {
        const at = Date.now();
        const item: Recent = tab.savedSessionId ? { kind: "saved", sessionId: tab.savedSessionId, name: tab.title, at } : { kind: "quick", target: tab.target ?? "", at };
        void invoke("recent_add", { item }).then(recentList).then(setRecents).catch(reason => setStatus(String(reason)));
      }
    }
    setTabs(current => current.map(tab => tab.id === id && !tab.exited ? { ...tab, sessionId: sessionId ?? undefined } : tab));
  }, [cancelTabTransfers]);
  const setCwd = useCallback((id: number, cwd: { host: string; path: string }) => {
    setTabs(current => current.map(tab => {
      if (tab.id !== id) return tab;
      const changed = tab.cwd?.path !== cwd.path || tab.cwd.host !== cwd.host;
      const follow = changed && (settingsRef.current.followTerminalFolder || (!tab.cwd && tab.browserPath === "" && tab.kind !== "ssh"));
      return { ...tab, cwd, browserPath: follow ? cwd.path : tab.browserPath };
    }));
  }, []);
  const setBrowserAccess = useCallback((id: number, sessionId: number, mode: "sftp" | "exec" | "local", sudo: boolean) => {
    setTabs(current => current.map(tab => tab.id === id && tab.sessionId === sessionId && !tab.exited
      ? { ...tab, browserAccess: { sessionId, mode, sudo } } : tab));
  }, []);
  const setPath = useCallback((id: number, browserPath: string) => {
    setTabs(current => current.map(tab => tab.id === id ? { ...tab, browserPath } : tab));
  }, []);
  const changeSettings = (input: Settings) => {
    const next = normalizeSettings(input);
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
    if (next.followTerminalFolder && !settings.followTerminalFolder) {
      setTabs(current => current.map(tab => tab.cwd ? { ...tab, browserPath: tab.cwd.path } : tab));
    }
  };
  const queuePrompt = useCallback((tabId: number, prompt: SshPrompt) => {
    if (tabId !== -1 && !liveTabs.current.has(tabId)) {
      void declinePrompt(prompt).catch(() => undefined);
      return;
    }
    if (promptQueue.current.some(item => item.prompt.requestId === prompt.requestId)) return;
    promptQueue.current = [...promptQueue.current, { tabId, prompt }];
    setPrompts([...promptQueue.current]);
  }, []);
  const answer = (item: QueuedPrompt, value: boolean | string | null) => {
    if (promptQueue.current[0] !== item) return;
    promptQueue.current = promptQueue.current.slice(1);
    setPrompts([...promptQueue.current]);
    const pending = item.prompt.type === "hostKey"
      ? answerHostKey(item.prompt.requestId, value === true)
      : answerSecret(item.prompt.requestId, typeof value === "string" ? value : null);
    void pending.catch(() => setStatus("SSH-Rückfrage konnte nicht beantwortet werden."));
  };
  useEffect(() => {
    const subscription = listen<number>("tunnel-prompt-closed", event => {
      promptQueue.current = promptQueue.current.filter(item => item.prompt.requestId !== event.payload);
      setPrompts([...promptQueue.current]);
    });
    return () => { void subscription.then(unlisten => unlisten()); };
  }, []);
  const currentPrompt = prompts[0];
  const activeTab = tabs.find(tab => tab.id === activeId) ?? null;
  const activeEditor = activeId === null ? undefined : editors[activeId];
  const browserTab = activeEditor && activeTab ? browserForEditor(activeTab, activeEditor.source, tabs) : activeTab;
  const quickTarget = activeTab?.kind === "ssh" && activeTab.sessionId !== undefined && !activeTab.exited && !activeTab.savedSessionId && !activeTab.saveDismissed ? parseQuickConnect(activeTab.target ?? "") : null;
  const offerSave = quickTarget && sessionsLoaded && !savedSessions.some(session => session.host.toLowerCase() === quickTarget.host.toLowerCase() && session.port === quickTarget.port && session.user === quickTarget.user);
  const dismissSave = (tabId: number) => setTabs(current => current.map(tab => tab.id === tabId ? { ...tab, saveDismissed: true } : tab));

  const showPanel = (index: number) => { setSidebarVisible(true); setSidebarPanel(index); };
  const toggleMultiExec = () => {
    if (multiExec) {
      setMultiExec(false);
      if (tabs.some(tab => tab.id === beforeMultiExec.current)) setActiveId(beforeMultiExec.current);
    } else {
      beforeMultiExec.current = activeId;
      setUnchecked(new Set());
      setMultiExec(true);
    }
  };
  const toggleSessionLog = (id: number) => {
    const tab = tabs.find(t => t.id === id);
    if (!tab || tab.exited || tab.kind === "editor" || tab.sessionId === undefined || logBusy.current.has(id)) return;
    logBusy.current.add(id);
    const operation = logPaths[id] ? stopLog(id).then(() => onLog(id, null)) : startLog(id, tab.title, settings).then(path => {
      if (tabsRef.current.some(t => t.id === id && !t.exited)) onLog(id, path);
      else return stopLog(id);
    });
    void operation.catch(reason => setStatus(`Protokoll: ${String(reason)}`)).finally(() => logBusy.current.delete(id));
  };
  const action = (name: string) => {
    setTemporaryMenu(false);
    if (name.startsWith("split:")) {
      if (multiExec) return;
      const mode = name.slice(6) as SplitMode;
      if (!["columns", "rows", "quad"].includes(mode)) return;
      changeSettings({ ...settings, splitMode: mode });
      const initialPanes = seedPanes(tabs.filter(tab => tab.kind !== "editor").map(tab => tab.id), activeId, paneCount(mode));
      setPanes(initialPanes);
      if (activeId === null) setActiveId(initialPanes[0]);
      setFocusedPane(0); setRatios({ x: 50, y: 50 }); return;
    }
    if (name.startsWith("saved:")) { const session = savedSessions.find(s => s.id === name.slice(6)); if (session) connectSaved(session); return; }
    if (name.startsWith("bars:")) { changeSettings({ ...settings, compact: false, bars: name.slice(5) as Settings["bars"] }); return; }
    if (name.startsWith("size:")) { changeSettings({ ...settings, toolbarSize: name.slice(5) as Settings["toolbarSize"] }); return; }
    switch (name) {
      case "paste": if (activeId !== null) terminalPasteRequests.get(activeId)?.(); break;
      case "logFolder": void openLogFolder(settings.logFolder).catch(reason => setStatus(String(reason))); break;
      case "logToggle": if (activeId !== null) toggleSessionLog(activeId); break;
      case "root": case "processes": case "hardware": openTab("local", name); break;
      case "openFile": void openFileDialog({ multiple: false, directory: false }).then(path => { if (typeof path === "string") openEditor({ id: 0, kind: "local", title: "Lokal", exited: false, browserPath: "" }, path); }).catch(reason => setStatus(String(reason))); break;
      case "compact": changeSettings({ ...settings, compact: !settings.compact }); break;
      case "left": case "right": changeSettings({ ...settings, sidebarRight: name === "right" }); break;
      case "tabNumbers": changeSettings({ ...settings, tabNumbers: !settings.tabNumbers }); break;
      case "tabClose": changeSettings({ ...settings, tabClose: !settings.tabClose }); break;
      case "single": if (!multiExec) changeSettings({ ...settings, splitMode: "single" }); break;
      case "ascii": case "ports": case "keygen": setTool(name); break;
      case "tux": setTimeout(() => window.dispatchEvent(new Event(tuxTestEvent)), 100); break;
      case "local": openTab("local"); break;
      case "wsl": if (hasWsl) openTab("wsl"); break;
      case "quick": setSidebarVisible(true); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="Quick connect"]')?.focus()); break;
      case "close": if (activeId !== null) closeTab(activeId); break;
      case "tunnels": setTunnelsOpen(true); void reloadTunnels().catch(reason => setStatus(String(reason))); break;
      case "quit": void closeRequest.current(); break;
      case "newSession": setSessionDialog({}); break;
      case "sessions": showPanel(0); break;
      case "mobaxterm": case "windterm": setImportSource(name); break;
      case "sidebar": setSidebarVisible(value => !value); break;
      case "browser": showPanel(3); break;
      case "multiexec": toggleMultiExec(); break;
      case "monitoring": changeSettings({ ...settings, monitoring: !settings.monitoring }); break;
      case "larger": case "smaller": case "resetFont": {
        const delta = name === "larger" ? 1 : -1;
        changeSettings({ ...settings, fontSize: name === "resetFont" ? 14 : settings.fontSize + delta, editorFontSize: name === "resetFont" ? 14 : settings.editorFontSize + delta }); break;
      }
      case "fullscreen": {
        if (fullscreenPending.current) break;
        fullscreenPending.current = true;
        const win = getCurrentWindow();
        void win.isFullscreen().then(value => win.setFullscreen(!value)).catch(reason => reportStatus(String(reason))).finally(() => { fullscreenPending.current = false; }); break;
      }
      case "settings": setSettingsOpen(true); break;
      case "shortcuts": setHelp("shortcuts"); break;
      case "about": setHelp("about"); break;
    }
  };
  const terminals = tabs.filter(tab => tab.kind !== "editor");
  const splitVisible = !multiExec && settings.splitMode !== "single" && activeId !== 0 && activeTab?.kind !== "editor";
  const terminalIds = terminals.map(tab => tab.id).join(",");
  useEffect(() => {
    if (settings.splitMode === "single") return;
    const ids = terminalIds ? terminalIds.split(",").map(Number) : [];
    setPanes(current => {
      const count = paneCount(settings.splitMode);
      let next = current.length ? cleanPanes(Array.from({ length: count }, (_, index) => current[index] ?? null), ids) : seedPanes(ids, activeId, count);
      if (splitVisible && activeId !== null && !next.includes(activeId)) next = assignPane(next, Math.min(focusedPane, count - 1), activeId);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [terminalIds, activeId, settings.splitMode, splitVisible, focusedPane]);
  const assignSplit = (index: number, id: number | null) => {
    setFocusedPane(index);
    setPanes(current => assignPane(current, index, id));
    setActiveId(id);
  };
  const gridVisible = multiExec && activeId !== 0 && activeTab?.kind !== "editor";
  const receiveInput = (focused: number, data: string, pasted: boolean) => {
    const recipients = terminals.map(tab => ({ id: tab.id, exited: tab.exited || !terminalWriters.has(tab.id), checked: !unchecked.has(tab.id) }));
    const targets = gridVisible ? inputTargets(focused, recipients) : recipients.filter(t => t.id === focused && !t.exited).map(t => t.id);
    if (!targets.length) return;
    if (pasted && shouldConfirmPaste(data, settings.pasteConfirm)) { setPasteRequest(current => current ?? { targets, data, multiExec: gridVisible }); return; }
    targets.forEach(id => terminalWriters.get(id)?.(data, pasted));
  };
  const menus = createMenus({ savedSessions, settings, hasWsl, activeId, multiExec, logging: !!(activeId && logPaths[activeId]), canLog: !!activeTab && activeTab.kind !== "editor" && !activeTab.exited && activeTab.sessionId !== undefined, canPaste: !!activeTab && activeTab.kind !== "editor" && !activeTab.exited && activeTab.sessionId !== undefined, isLinux: /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent) });
  const restoreTabs = () => setRestoreQueue([...lastTabs]);
  return <div className={`app-shell toolbar-${settings.toolbarSize} ${settings.compact ? "compact" : ""}`}>
    <div hidden={!temporaryMenu && (settings.compact || settings.bars === "toolbar")}><MenuBar menus={menus} onAction={action} /></div>
    {!settings.compact && settings.bars !== "menu" && <Toolbar hasWsl={hasWsl} menus={menus} shellName={shellName} multiExec={multiExec} onAction={action} />}
    <div className={`workspace ${settings.sidebarRight ? "sidebar-right" : ""}`}>
      {sidebarVisible && <Sidebar onMultiExec={toggleMultiExec} active={sidebarPanel} onActive={setSidebarPanel} onOpenSettings={() => setSettingsOpen(true)} onAccess={setBrowserAccess} onOpenFile={openEditor} savedSessions={savedSessions} onSavedConnect={connectSaved} onEditSession={session => setSessionDialog({ session })} onReloadSessions={reloadSessions} transferQueue={transferQueue} onStatus={reportStatus} onConnect={connect} tab={browserTab} settings={settings} onSettings={changeSettings} onPath={setPath} />}
      <main className="terminal-workspace" aria-label="Terminalbereich">
        <TabBar onLogToggle={toggleSessionLog} onOpenLogFolder={() => action("logFolder")} showNumbers={settings.tabNumbers} showClose={settings.tabClose} tabs={tabs.map(tab => ({ ...tab, connected: tab.sessionId !== undefined, shell: shellName, logPath: logPaths[tab.id], dirty: editors[tab.id]?.dirty, tooltip: editors[tab.id]?.document.path ?? (() => { const session = savedSessions.find(s => s.id === tab.savedSessionId); return session ? [tab.title, jumpHostHint(session, savedSessions)].filter(Boolean).join(" – ") : tab.title; })() }))} activeId={activeId} hasWsl={hasWsl} onOpen={openTab} onClose={closeTab} onSelect={id => { if (panes.includes(id)) setFocusedPane(panes.indexOf(id)); setActiveId(id); }} />
        {activeId === 0 && <Home sessions={savedSessions} recents={recents} canRestore={lastTabs.length > 0 && sessionsLoaded && shellsLoaded && restoreQueue === null} onLocal={() => openTab("local")} onRestore={restoreTabs} onSaved={connectSaved} onQuick={connect} />}
        {offerSave && activeTab && quickTarget && <div className="connection-save"><span>Verbindung speichern?</span><button title="Verbindung als Sitzung speichern" onClick={() => setSessionDialog({ tabId: activeTab.id, preferPassword: true, session: { kind: "ssh", id: "", name: `${quickTarget.user}@${quickTarget.host}`, folder: "", host: quickTarget.host, port: quickTarget.port, user: quickTarget.user, auth: { type: "default" }, source: null } })}>Speichern…</button><button title="Hinweis für diesen Tab schließen" onClick={() => dismissSave(activeTab.id)}>Nicht jetzt</button></div>}
        {gridVisible && <div className="multiexec-header"><strong>MultiExec aktiv</strong><button onClick={() => setUnchecked(new Set())}>Alle</button><button onClick={() => setUnchecked(new Set(terminals.map(t => t.id)))}>Keine</button><button onClick={toggleMultiExec}>Beenden</button></div>}
        <div className={`terminal-stack ${gridVisible ? "multiexec-grid" : ""}`} style={gridVisible ? { gridTemplateColumns: `repeat(${gridColumns(terminals.length)}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(terminals.length / gridColumns(terminals.length))}, minmax(0, 1fr))` } : undefined}>
          <Suspense fallback={null}>{tabs.filter(tab => tab.kind !== "editor").map(tab => <TerminalView logPath={logPaths[tab.id]} connected={tab.sessionId !== undefined} onLogToggle={toggleSessionLog} title={tab.title} logAlways={!!savedSessions.find(s => s.id === tab.savedSessionId)?.log_always} onLog={onLog} key={tab.id} id={tab.id} serial={tab.serial} kind={tab.kind as ShellKind | "ssh" | "telnet" | "serial"} target={tab.target} savedSessionId={tab.savedSessionId} startCommand={tab.startCommand} active={tab.id === activeId} visible={splitVisible ? panes.includes(tab.id) : gridVisible || tab.id === activeId} paneStyle={splitVisible && panes.includes(tab.id) ? { ...paneStyle(settings.splitMode, panes.indexOf(tab.id), ratios.x, ratios.y), paddingTop: 38 } : undefined} onFocusPane={splitVisible ? () => { setFocusedPane(panes.indexOf(tab.id)); setActiveId(tab.id); } : undefined} exited={tab.exited}
            onInput={receiveInput} monitoringSession={settings.monitoring && tab.id === activeId && tab.kind === "ssh" && !tab.exited ? tab.sessionId : undefined}
            gridFooter={gridVisible ? <div className="multiexec-footer"><span>{tab.title}</span><label><input type="checkbox" disabled={tab.exited} checked={!unchecked.has(tab.id)} onChange={e => setUnchecked(current => { const next = new Set(current); if (e.target.checked) next.delete(tab.id); else next.add(tab.id); return next; })} />Eingaben empfangen</label></div> : undefined}
            preferences={settings} shellIntegration={settings.shellIntegration} sshPromptCommand={settings.sshPromptCommand}
            onExit={markExited} onStatus={setStatus} onSession={setSession} onCwd={setCwd} onPrompt={queuePrompt} onClearPrompts={removePrompts} />)}</Suspense>
          {splitVisible && <SplitLayout mode={settings.splitMode} panes={panes} terminals={terminals} focusedIndex={activeId !== null && panes.includes(activeId) ? panes.indexOf(activeId) : focusedPane} ratios={ratios} onRatios={setRatios} onAssign={assignSplit}
            onFocus={index => { setFocusedPane(index); setActiveId(panes[index] ?? null); }}
            onNew={index => { setFocusedPane(index); const id = nextId.current; openTab("local"); setPanes(current => assignPane(current, index, id)); }} />}
          <Suspense fallback={<div className="terminal-empty">Editor wird geladen…</div>}>{Object.entries(editors).map(([key, editor]) => {
            const id = Number(key);
            return <div key={id} id={`editor-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} hidden={activeId !== id} style={{ height: "100%" }}><EditorView settings={settings} ref={handle => { if (handle) editorHandles.current.set(id, handle); else editorHandles.current.delete(id); }} document={editor.document}
              onDirtyChange={dirty => setEditors(current => !current[id] || current[id].dirty === dirty ? current : { ...current, [id]: { ...current[id], dirty } })}
              onStatusChange={status => setEditors(current => !current[id] || current[id].status === status ? current : { ...current, [id]: { ...current[id], status } })}
              onDocumentChange={document => setEditors(current => !current[id] ? current : { ...current, [id]: { ...current[id], document } })} /></div>;
          })}</Suspense>
        </div>
      </main>
    </div>
    <footer className="statusbar" role="status" aria-live="polite">{activeTunnels > 0 && <button onClick={() => setTunnelsOpen(true)}>Tunnel: {activeTunnels} aktiv</button>}{multiExec && <span>MultiExec: {terminals.filter(t => !t.exited && !unchecked.has(t.id)).length} von {terminals.length} Terminals · </span>}{activeTab && connectionStatus(activeTab.kind, activeTab.serial) && <span>{connectionStatus(activeTab.kind, activeTab.serial)} · </span>}<span>{transfer ? `${transfer.text}${transfer.queued > 0 ? ` +${transfer.queued} in Warteschlange` : ""}` : activeEditor?.status ?? status}</span>{transfer && <button type="button" onClick={() => transferQueue.cancelCurrent()}>Abbrechen</button>}</footer>
    {pasteRequest && <PasteDialog text={pasteRequest.data} count={pasteRequest.targets.length} multiExec={pasteRequest.multiExec} onAnswer={text => {
      if (text !== null) pasteRequest.targets.forEach(id => { if (tabsRef.current.some(t => t.id === id && !t.exited)) terminalWriters.get(id)?.(text, true); });
      setPasteRequest(null);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`#terminal-${activeId} .xterm-helper-textarea`)?.focus());
    }} />}
    {tunnelsOpen && <TunnelDialog sessions={savedSessions} tunnels={tunnels} statuses={tunnelStatuses} reload={reloadTunnels} start={startTunnel} onClose={() => setTunnelsOpen(false)} />}
    {tunnelConfirmation && <TunnelConfirmDialog onAnswer={accepted => { setTunnelConfirmation(null); tunnelConfirmation(accepted); }} />}
    {tool && <ToolDialog kind={tool} onClose={() => setTool(null)} />}
    {settingsOpen && <SettingsDialog settings={settings} onChange={changeSettings} onClearRecents={() => { void invoke("recent_clear").then(() => setRecents([])).catch(reason => setStatus(String(reason))); }} onClose={() => setSettingsOpen(false)} />}
    {help && <HelpDialog about={help === "about"} onClose={() => setHelp(null)} />}
    {importSource && <ImportDialog source={importSource} onClose={() => setImportSource(null)} onImported={result => { setImportSource(null); reloadSessions(); reportStatus(`${result.imported} Sitzungen importiert`); }} />}
    {sshClose && <SshCloseDialog {...sshClose} onAnswer={sshClose.answer} />}
    {closeEditorId !== null && editors[closeEditorId] && <EditorCloseDialog key={closeEditorId} name={editors[closeEditorId].document.name} busy={closeEditorBusy} onAnswer={answer => void answerEditorClose(answer)} />}
    {sessionDialog && <SessionDialog session={sessionDialog.session} preferPassword={sessionDialog.preferPassword} sessions={savedSessions} onClose={() => setSessionDialog(null)} onSaved={() => { if (sessionDialog.tabId !== undefined) dismissSave(sessionDialog.tabId); setSessionDialog(null); reloadSessions(); setStatus("Sitzung gespeichert"); }} />}
    {userSession && <SessionUserDialog name={userSession.name} onAnswer={user => { const session = userSession; setUserSession(null); if (user !== null) connectSaved(session, user); }} />}
    {quickUserTarget && <SessionUserDialog name={quickUserTarget} onAnswer={user => { const target = quickUserTarget; setQuickUserTarget(null); if (user !== null) connect(`${user}@${target}`); }} />}
    {conflict && <FileActionDialog key={conflictSequence} prompt={conflict} />}
    {currentPrompt?.prompt.type === "hostKey" && <HostKeyDialog key={currentPrompt.prompt.requestId} prompt={currentPrompt.prompt} onAnswer={value => answer(currentPrompt, value)} />}
    {currentPrompt?.prompt.type === "secret" && <SecretDialog key={currentPrompt.prompt.requestId} prompt={currentPrompt.prompt} onAnswer={value => answer(currentPrompt, value)} />}
  </div>;
}
