import { useCallback, useEffect, useRef, useState } from "react";
import { MenuBar } from "./components/MenuBar";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { TabBar, type TerminalTab } from "./components/TabBar";
import { TerminalView } from "./components/TerminalView";
import { availableShells, type ShellKind } from "./lib/pty";
import "./styles/theme.css";
import "./App.css";

function localTitle() { return /Windows/i.test(navigator.userAgent) ? "PowerShell" : "Shell"; }
export default function App() {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [{ id: 1, kind: "local", title: `${localTitle()} 1`, exited: false }]);
  const [activeId, setActiveId] = useState<number | null>(1);
  const [hasWsl, setHasWsl] = useState(false);
  const [status, setStatus] = useState("Bereit");
  const nextId = useRef(2);
  useEffect(() => {
    let cancelled = false;
    void availableShells().then(shells => { if (!cancelled) setHasWsl(shells.includes("wsl")); }).catch((error: unknown) => { if (!cancelled) setStatus(`Verfügbare Shells konnten nicht geladen werden: ${String(error)}`); });
    return () => { cancelled = true; };
  }, []);
  const openTab = (kind: ShellKind) => {
    const id = nextId.current++;
    setTabs(current => [...current, { id, kind, title: `${kind === "wsl" ? "WSL" : localTitle()} ${id}`, exited: false }]);
    setActiveId(id);
  };
  const closeTab = (id: number) => {
    const index = tabs.findIndex(tab => tab.id === id);
    if (activeId === id) setActiveId(tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null);
    setTabs(current => current.filter(tab => tab.id !== id));
  };
  const markExited = useCallback((id: number) => setTabs(current => current.map(tab => tab.id === id ? { ...tab, exited: true } : tab)), []);
  return <div className="app-shell"><MenuBar /><Toolbar hasWsl={hasWsl} onOpen={openTab} /><div className="workspace"><Sidebar onStatus={setStatus} /><main className="terminal-workspace" aria-label="Terminalbereich"><TabBar tabs={tabs} activeId={activeId} hasWsl={hasWsl} onOpen={openTab} onClose={closeTab} onSelect={setActiveId} /><div className="terminal-stack">{tabs.map(tab => <TerminalView key={tab.id} id={tab.id} kind={tab.kind} active={tab.id === activeId} onExit={markExited} onStatus={setStatus} />)}{tabs.length === 0 && <div className="terminal-empty">Öffne ein Terminal über + oder die Werkzeugleiste.</div>}</div></main></div><footer className="statusbar" role="status" aria-live="polite">{status}</footer></div>;
}
