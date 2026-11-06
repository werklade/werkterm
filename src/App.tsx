import { useCallback, useEffect, useRef, useState } from "react";
import { MenuBar } from "./components/MenuBar";
import { Toolbar } from "./components/Toolbar";
import { Sidebar, type BrowserTab } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TerminalView } from "./components/TerminalView";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { SecretDialog } from "./components/SecretDialog";
import { availableShells, type ShellKind } from "./lib/pty";
import { answerHostKey, answerSecret, type SshPrompt } from "./lib/ssh";
import { loadSettings, saveSettings, type Settings } from "./lib/settings";
import { parseQuickConnect } from "./lib/quickConnect";
import "./styles/theme.css";
import "./App.css";

interface QueuedPrompt { tabId: number; prompt: SshPrompt }
function localTitle() { return /Windows/i.test(navigator.userAgent) ? "PowerShell" : "Shell"; }
function declinePrompt(prompt: SshPrompt) {
  return prompt.type === "hostKey" ? answerHostKey(prompt.requestId, false) : answerSecret(prompt.requestId, null);
}

export default function App() {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [{ id: 1, kind: "local", title: `${localTitle()} 1`, exited: false, browserPath: "" }]);
  const [activeId, setActiveId] = useState<number | null>(1);
  const [hasWsl, setHasWsl] = useState(false);
  const [status, setStatus] = useState("Bereit");
  const [settings, setSettings] = useState(loadSettings);
  const [prompts, setPrompts] = useState<QueuedPrompt[]>([]);
  const promptQueue = useRef<QueuedPrompt[]>([]);
  const liveTabs = useRef(new Set([1]));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const nextId = useRef(2);

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
    setTabs(current => [...current, { id, kind: "ssh", target: target.trim(), title: `${parsed.user}@${parsed.host}`, exited: false, browserPath: "" }]);
    setActiveId(id);
    setStatus(`Verbinde mit ${parsed.user}@${parsed.host}…`);
  };
  const closeTab = (id: number) => {
    liveTabs.current.delete(id);
    removePrompts(id);
    const index = tabs.findIndex(tab => tab.id === id);
    if (activeId === id) setActiveId(tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null);
    setTabs(current => current.filter(tab => tab.id !== id));
  };
  const markExited = useCallback((id: number) => {
    liveTabs.current.delete(id);
    removePrompts(id);
    setTabs(current => current.map(tab => tab.id === id ? { ...tab, exited: true, sessionId: undefined } : tab));
  }, [removePrompts]);
  const setSession = useCallback((id: number, sessionId: number | null) => {
    setTabs(current => current.map(tab => tab.id === id && !tab.exited ? { ...tab, sessionId: sessionId ?? undefined } : tab));
  }, []);
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

  return <div className="app-shell">
    <MenuBar />
    <Toolbar hasWsl={hasWsl} onOpen={openTab} />
    <div className="workspace">
      <Sidebar onStatus={setStatus} onConnect={connect} tab={activeTab} settings={settings} onSettings={changeSettings} onPath={setPath} />
      <main className="terminal-workspace" aria-label="Terminalbereich">
        <TabBar tabs={tabs} activeId={activeId} hasWsl={hasWsl} onOpen={openTab} onClose={closeTab} onSelect={setActiveId} />
        <div className="terminal-stack">
          {tabs.map(tab => <TerminalView key={tab.id} id={tab.id} kind={tab.kind} target={tab.target} active={tab.id === activeId}
            shellIntegration={settings.shellIntegration} sshPromptCommand={settings.sshPromptCommand}
            onExit={markExited} onStatus={setStatus} onSession={setSession} onCwd={setCwd} onPrompt={queuePrompt} />)}
          {tabs.length === 0 && <div className="terminal-empty">Öffne ein Terminal über + oder die Werkzeugleiste.</div>}
        </div>
      </main>
    </div>
    <footer className="statusbar" role="status" aria-live="polite">{status}</footer>
    {currentPrompt?.prompt.type === "hostKey" && <HostKeyDialog key={currentPrompt.prompt.requestId} prompt={currentPrompt.prompt} onAnswer={value => answer(currentPrompt, value)} />}
    {currentPrompt?.prompt.type === "secret" && <SecretDialog key={currentPrompt.prompt.requestId} prompt={currentPrompt.prompt} onAnswer={value => answer(currentPrompt, value)} />}
  </div>;
}
