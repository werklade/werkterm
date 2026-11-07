import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { MenuBar } from "./components/MenuBar";
import { Toolbar } from "./components/Toolbar";
import { Sidebar, type BrowserTab } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { SecretDialog } from "./components/SecretDialog";
import { SessionDialog } from "./components/SessionDialog";
import { SessionUserDialog } from "./components/SessionUserDialog";
import { listSessions, sessionTarget, type SavedSession } from "./lib/sessions";
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
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [{ id: 1, kind: "local", title: `${localTitle()} 1`, exited: false, browserPath: "" }]);
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
  const [closeEditorId, setCloseEditorId] = useState<number | null>(null);
  const [closeEditorBusy, setCloseEditorBusy] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(1);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [hasWsl, setHasWsl] = useState(false);
  const [transfer, setTransfer] = useState<QueueState>(null);
  const [status, setStatus] = useState("Bereit");
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [sessionDialog, setSessionDialog] = useState<{ session?: SavedSession; tabId?: number; preferPassword?: boolean } | null>(null);
  const [userSession, setUserSession] = useState<SavedSession | null>(null);
  const [quickUserTarget, setQuickUserTarget] = useState<string | null>(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const reloadSessions = useCallback(() => { void listSessions().then(items => { setSavedSessions(items); setSessionsLoaded(true); }).catch(() => setStatus("Gespeicherte Sitzungen konnten nicht geladen werden.")); }, []);
  useEffect(reloadSessions, [reloadSessions]);
  const [settings, setSettings] = useState(loadSettings);
  const [prompts, setPrompts] = useState<QueuedPrompt[]>([]);
  const promptQueue = useRef<QueuedPrompt[]>([]);
  const liveTabs = useRef(new Set([1]));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const nextId = useRef(2);
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
    void availableShells().then(shells => { if (!cancelled) setHasWsl(shells.includes("wsl")); }).catch((error: unknown) => {
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
  const openTab = (kind: ShellKind) => {
    if (windowClosing.current) return;
    const id = nextId.current++;
    liveTabs.current.add(id);
    setTabs(current => [...current, { id, kind, title: `${kind === "wsl" ? "WSL" : localTitle()} ${id}`, exited: false, browserPath: "" }]);
    setActiveId(id);
  };
  const connect = (target: string) => {
    if (windowClosing.current) return;
    const parsed = parseQuickConnect(target);
    if (!parsed) return;
    if (!parsed.user) { setQuickUserTarget(target.trim()); return; }
    const id = nextId.current++;
    liveTabs.current.add(id);
    sshTabs.current.add(id);
    setTabs(current => [...current, { id, kind: "ssh", target: target.trim(), title: `${parsed.user}@${parsed.host}`, exited: false, browserPath: "" }]);
    setActiveId(id);
    setStatus(`Verbinde mit ${parsed.user}@${parsed.host}…`);
  };
  const connectSaved = (session: SavedSession, userOverride?: string) => {
    if (windowClosing.current) return;
    if (!session.user && !userOverride) { setUserSession(session); return; }
    const id = nextId.current++;
    liveTabs.current.add(id);
    sshTabs.current.add(id);
    setTabs(current => [...current, { id, kind: "ssh", target: sessionTarget(session, userOverride), savedSessionId: session.id, title: session.name, exited: false, browserPath: "" }]);
    setActiveId(id);
    setStatus(`Verbinde mit ${session.name}…`);
  };
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
    if (activeIdRef.current === id) setActiveId(currentTabs[index + 1]?.id ?? currentTabs[index - 1]?.id ?? null);
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
  const closeTab = (id: number) => {
    if (windowClosing.current || closing.current.size) return;
    if (!editorsRef.current[id]) { removeTab(id); return; }
    closing.current.add(id);
    void closeEditors([id], true).catch(reason => reportStatus(String(reason)))
      .finally(() => closing.current.delete(id));
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
      await Promise.all(pendingOpens.current.values());
      // Freeze every document so a previously clean tab cannot become dirty mid-sequence.
      for (const handle of [...editorHandles.current.values()]) { locked.push(handle); await handle.lock(); }
      const ids = Object.keys(editorsRef.current).map(Number);
      if (await closeEditors(ids, false)) await getCurrentWindow().destroy();
    } catch (reason) { reportStatus("Fenster konnte nicht geschlossen werden: " + String(reason)); }
    finally { for (const handle of locked) handle.unlock(); windowClosing.current = false; }
  };
  const openEditor = (browserSource: BrowserTab, path: string) => {
    if (windowClosing.current) return;
    const source = sourceForEditorOpen(browserSource, editorsRef.current[browserSource.id]?.source);
    if (source.kind === "editor") return;
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
    else if (liveTabs.current.has(id) && sshTabs.current.has(id)) sessions.current.set(id, sessionId);
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
  const changeSettings = (next: Settings) => {
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
    if (next.followTerminalFolder && !settings.followTerminalFolder) {
      setTabs(current => current.map(tab => tab.cwd ? { ...tab, browserPath: tab.cwd.path } : tab));
    }
  };
  const queuePrompt = useCallback((tabId: number, prompt: SshPrompt) => {
    if (!liveTabs.current.has(tabId)) {
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
  const currentPrompt = prompts[0];
  const activeTab = tabs.find(tab => tab.id === activeId) ?? null;
  const activeEditor = activeId === null ? undefined : editors[activeId];
  const browserTab = activeEditor && activeTab ? browserForEditor(activeTab, activeEditor.source, tabs) : activeTab;
  const quickTarget = activeTab?.kind === "ssh" && activeTab.sessionId !== undefined && !activeTab.exited && !activeTab.savedSessionId && !activeTab.saveDismissed ? parseQuickConnect(activeTab.target ?? "") : null;
  const offerSave = quickTarget && sessionsLoaded && !savedSessions.some(session => session.host.toLowerCase() === quickTarget.host.toLowerCase() && session.port === quickTarget.port && session.user === quickTarget.user);
  const dismissSave = (tabId: number) => setTabs(current => current.map(tab => tab.id === tabId ? { ...tab, saveDismissed: true } : tab));

  return <div className="app-shell">
    <MenuBar />
    <Toolbar hasWsl={hasWsl} onOpen={openTab} />
    <div className="workspace">
      <Sidebar onAccess={setBrowserAccess} onOpenFile={openEditor} savedSessions={savedSessions} onSavedConnect={connectSaved} onEditSession={session => setSessionDialog({ session })} onReloadSessions={reloadSessions} transferQueue={transferQueue} onStatus={reportStatus} onConnect={connect} tab={browserTab} settings={settings} onSettings={changeSettings} onPath={setPath} />
      <main className="terminal-workspace" aria-label="Terminalbereich">
        <TabBar tabs={tabs.map(tab => ({ ...tab, dirty: editors[tab.id]?.dirty, tooltip: editors[tab.id]?.document.path }))} activeId={activeId} hasWsl={hasWsl} onOpen={openTab} onClose={closeTab} onSelect={setActiveId} />
        {offerSave && activeTab && quickTarget && <div className="connection-save"><span>Verbindung speichern?</span><button title="Verbindung als Sitzung speichern" onClick={() => setSessionDialog({ tabId: activeTab.id, preferPassword: true, session: { kind: "ssh", id: "", name: `${quickTarget.user}@${quickTarget.host}`, folder: "", host: quickTarget.host, port: quickTarget.port, user: quickTarget.user, auth: { type: "default" }, source: null } })}>Speichern…</button><button title="Hinweis für diesen Tab schließen" onClick={() => dismissSave(activeTab.id)}>Nicht jetzt</button></div>}
        <div className="terminal-stack">
          <Suspense fallback={null}>{tabs.filter(tab => tab.kind !== "editor").map(tab => <TerminalView key={tab.id} id={tab.id} kind={tab.kind as ShellKind | "ssh"} target={tab.target} savedSessionId={tab.savedSessionId} active={tab.id === activeId}
            shellIntegration={settings.shellIntegration} sshPromptCommand={settings.sshPromptCommand}
            onExit={markExited} onStatus={setStatus} onSession={setSession} onCwd={setCwd} onPrompt={queuePrompt} onClearPrompts={removePrompts} />)}</Suspense>
          <Suspense fallback={<div className="terminal-empty">Editor wird geladen…</div>}>{Object.entries(editors).map(([key, editor]) => {
            const id = Number(key);
            return <div key={id} id={`editor-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} hidden={activeId !== id} style={{ height: "100%" }}><EditorView ref={handle => { if (handle) editorHandles.current.set(id, handle); else editorHandles.current.delete(id); }} document={editor.document}
              onDirtyChange={dirty => setEditors(current => !current[id] || current[id].dirty === dirty ? current : { ...current, [id]: { ...current[id], dirty } })}
              onStatusChange={status => setEditors(current => !current[id] || current[id].status === status ? current : { ...current, [id]: { ...current[id], status } })}
              onDocumentChange={document => setEditors(current => !current[id] ? current : { ...current, [id]: { ...current[id], document } })} /></div>;
          })}</Suspense>
          {tabs.length === 0 && <div className="terminal-empty">Öffne ein Terminal über + oder die Werkzeugleiste.</div>}
        </div>
      </main>
    </div>
    <footer className="statusbar" role="status" aria-live="polite"><span>{transfer ? `${transfer.text}${transfer.queued > 0 ? ` +${transfer.queued} in Warteschlange` : ""}` : activeEditor?.status ?? status}</span>{transfer && <button type="button" onClick={() => transferQueue.cancelCurrent()}>Abbrechen</button>}</footer>
    {closeEditorId !== null && editors[closeEditorId] && <EditorCloseDialog key={closeEditorId} name={editors[closeEditorId].document.name} busy={closeEditorBusy} onAnswer={answer => void answerEditorClose(answer)} />}
    {sessionDialog && <SessionDialog session={sessionDialog.session} preferPassword={sessionDialog.preferPassword} sessions={savedSessions} onClose={() => setSessionDialog(null)} onSaved={() => { if (sessionDialog.tabId !== undefined) dismissSave(sessionDialog.tabId); setSessionDialog(null); reloadSessions(); setStatus("Sitzung gespeichert"); }} />}
    {userSession && <SessionUserDialog name={userSession.name} onAnswer={user => { const session = userSession; setUserSession(null); if (user !== null) connectSaved(session, user); }} />}
    {quickUserTarget && <SessionUserDialog name={quickUserTarget} onAnswer={user => { const target = quickUserTarget; setQuickUserTarget(null); if (user !== null) connect(`${user}@${target}`); }} />}
    {conflict && <FileActionDialog key={conflictSequence} prompt={conflict} />}
    {currentPrompt?.prompt.type === "hostKey" && <HostKeyDialog key={currentPrompt.prompt.requestId} prompt={currentPrompt.prompt} onAnswer={value => answer(currentPrompt, value)} />}
    {currentPrompt?.prompt.type === "secret" && <SecretDialog key={currentPrompt.prompt.requestId} prompt={currentPrompt.prompt} onAnswer={value => answer(currentPrompt, value)} />}
  </div>;
}
