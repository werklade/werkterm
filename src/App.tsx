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
import { Channel } from "@tauri-apps/api/core";
import { allocateTransferId, cancelTransfer, downloadFile, uploadFile, type TransferProgress } from "./lib/transfers";
import { TransferQueue, type QueueState, type ConflictResolution } from "./lib/transferQueue";
import { FileActionDialog, type FileDialog } from "./components/FileActionDialog";
import "./styles/theme.css";
import "./App.css";

const TerminalView = lazy(() => import("./components/TerminalView").then(module => ({ default: module.TerminalView })));

interface QueuedPrompt { tabId: number; prompt: SshPrompt }
function localTitle() { return /Windows/i.test(navigator.userAgent) ? "PowerShell" : "Shell"; }
function declinePrompt(prompt: SshPrompt) {
  return prompt.type === "hostKey" ? answerHostKey(prompt.requestId, false) : answerSecret(prompt.requestId, null);
}

export default function App() {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [{ id: 1, kind: "local", title: `${localTitle()} 1`, exited: false, browserPath: "" }]);
  const [activeId, setActiveId] = useState<number | null>(1);
  const [hasWsl, setHasWsl] = useState(false);
  const [transfer, setTransfer] = useState<QueueState>(null);
  const [status, setStatus] = useState("Bereit");
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [sessionDialog, setSessionDialog] = useState<{ session?: SavedSession; tabId?: number; preferPassword?: boolean } | null>(null);
  const [userSession, setUserSession] = useState<SavedSession | null>(null);
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
    const id = nextId.current++;
    liveTabs.current.add(id);
    setTabs(current => [...current, { id, kind, title: `${kind === "wsl" ? "WSL" : localTitle()} ${id}`, exited: false, browserPath: "" }]);
    setActiveId(id);
  };
  const connect = (target: string) => {
    const parsed = parseQuickConnect(target);
    if (!parsed) return;
    const id = nextId.current++;
    liveTabs.current.add(id);
    sshTabs.current.add(id);
    setTabs(current => [...current, { id, kind: "ssh", target: target.trim(), title: `${parsed.user}@${parsed.host}`, exited: false, browserPath: "" }]);
    setActiveId(id);
    setStatus(`Verbinde mit ${parsed.user}@${parsed.host}…`);
  };
  const connectSaved = (session: SavedSession, userOverride?: string) => {
    if (!session.user && !userOverride) { setUserSession(session); return; }
    const id = nextId.current++;
    liveTabs.current.add(id);
    sshTabs.current.add(id);
    setTabs(current => [...current, { id, kind: "ssh", target: sessionTarget(session, userOverride), savedSessionId: session.id, title: session.name, exited: false, browserPath: "" }]);
    setActiveId(id);
    setStatus(`Verbinde mit ${session.name}…`);
  };
  const closeTab = (id: number) => {
    cancelTabTransfers(id);
    liveTabs.current.delete(id);
    removePrompts(id);
    const index = tabs.findIndex(tab => tab.id === id);
    if (tabs[index]?.kind === "ssh" && tabs[index]?.sessionId === undefined && !tabs[index]?.exited) setStatus("Verbindungsaufbau abgebrochen");
    if (activeId === id) setActiveId(tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null);
    setTabs(current => current.filter(tab => tab.id !== id));
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
  const quickTarget = activeTab?.kind === "ssh" && activeTab.sessionId !== undefined && !activeTab.exited && !activeTab.savedSessionId && !activeTab.saveDismissed ? parseQuickConnect(activeTab.target ?? "") : null;
  const offerSave = quickTarget && sessionsLoaded && !savedSessions.some(session => session.host.toLowerCase() === quickTarget.host.toLowerCase() && session.port === quickTarget.port && session.user === quickTarget.user);
  const dismissSave = (tabId: number) => setTabs(current => current.map(tab => tab.id === tabId ? { ...tab, saveDismissed: true } : tab));

  return <div className="app-shell">
    <MenuBar />
    <Toolbar hasWsl={hasWsl} onOpen={openTab} />
    <div className="workspace">
      <Sidebar savedSessions={savedSessions} onSavedConnect={connectSaved} onEditSession={session => setSessionDialog({ session })} onReloadSessions={reloadSessions} transferQueue={transferQueue} onStatus={setStatus} onConnect={connect} tab={activeTab} settings={settings} onSettings={changeSettings} onPath={setPath} />
      <main className="terminal-workspace" aria-label="Terminalbereich">
        <TabBar tabs={tabs} activeId={activeId} hasWsl={hasWsl} onOpen={openTab} onClose={closeTab} onSelect={setActiveId} />
        {offerSave && activeTab && quickTarget && <div className="connection-save"><span>Verbindung speichern?</span><button title="Verbindung als Sitzung speichern" onClick={() => setSessionDialog({ tabId: activeTab.id, preferPassword: true, session: { id: "", name: `${quickTarget.user}@${quickTarget.host}`, folder: "", host: quickTarget.host, port: quickTarget.port, user: quickTarget.user, auth: { type: "default" }, source: null } })}>Speichern…</button><button title="Hinweis für diesen Tab schließen" onClick={() => dismissSave(activeTab.id)}>Nicht jetzt</button></div>}
        <div className="terminal-stack">
          <Suspense fallback={null}>{tabs.map(tab => <TerminalView key={tab.id} id={tab.id} kind={tab.kind} target={tab.target} savedSessionId={tab.savedSessionId} active={tab.id === activeId}
            shellIntegration={settings.shellIntegration} sshPromptCommand={settings.sshPromptCommand}
            onExit={markExited} onStatus={setStatus} onSession={setSession} onCwd={setCwd} onPrompt={queuePrompt} onClearPrompts={removePrompts} />)}</Suspense>
          {tabs.length === 0 && <div className="terminal-empty">Öffne ein Terminal über + oder die Werkzeugleiste.</div>}
        </div>
      </main>
    </div>
    <footer className="statusbar" role="status" aria-live="polite"><span>{transfer ? `${transfer.text}${transfer.queued > 0 ? ` +${transfer.queued} in Warteschlange` : ""}` : status}</span>{transfer && <button type="button" onClick={() => transferQueue.cancelCurrent()}>Abbrechen</button>}</footer>
    {sessionDialog && <SessionDialog session={sessionDialog.session} preferPassword={sessionDialog.preferPassword} sessions={savedSessions} onClose={() => setSessionDialog(null)} onSaved={() => { if (sessionDialog.tabId !== undefined) dismissSave(sessionDialog.tabId); setSessionDialog(null); reloadSessions(); setStatus("Sitzung gespeichert"); }} />}
    {userSession && <SessionUserDialog name={userSession.name} onAnswer={user => { const session = userSession; setUserSession(null); if (user !== null) connectSaved(session, user); }} />}
    {conflict && <FileActionDialog key={conflictSequence} prompt={conflict} />}
    {currentPrompt?.prompt.type === "hostKey" && <HostKeyDialog key={currentPrompt.prompt.requestId} prompt={currentPrompt.prompt} onAnswer={value => answer(currentPrompt, value)} />}
    {currentPrompt?.prompt.type === "secret" && <SecretDialog key={currentPrompt.prompt.requestId} prompt={currentPrompt.prompt} onAnswer={value => answer(currentPrompt, value)} />}
  </div>;
}
