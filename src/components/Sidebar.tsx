import { useEffect, useState, type CSSProperties } from "react";
import { ResizeGrip } from "./ResizeGrip";
import { clampPanel, DEFAULT_PANEL_WIDTH, loadWidth, storeWidth } from "../lib/browserWidths";
import { SessionsPanel } from "./SessionsPanel";
import type { SavedSession } from "../lib/sessions";
import { Icon, type IconName } from "./Icon";
import { parseQuickConnect } from "../lib/quickConnect";
import { FileBrowser, type BrowserTab } from "./FileBrowser";
import type { TransferQueueHandle } from "../lib/transferQueue";
import type { Settings } from "../lib/settings";

export type { BrowserTab } from "./FileBrowser";

const panels: { name: string; icon: IconName; placeholder: string }[] = [
  { name: "Sessions", icon: "star", placeholder: "Noch keine gespeicherten Sitzungen." },
  { name: "Tools", icon: "tools", placeholder: "Werkzeuge folgen in einer späteren Phase." },
  { name: "Macros", icon: "macros", placeholder: "Makros folgen in einer späteren Version" },
  { name: "SSH-Browser", icon: "globe", placeholder: "Keine SSH-Sitzung verbunden" },
];
interface Props {
  onMultiExec: () => void;
  active: number; onActive(value: number): void; onOpenSettings(): void;
  onStatus: (message: string) => void;
  onOpenFile: (tab: BrowserTab, path: string) => void;
  transferQueue: TransferQueueHandle;
  onConnect: (target: string) => void;
  savedSessions: SavedSession[];
  onSavedConnect: (session: SavedSession) => void;
  onEditSession: (session?: SavedSession) => void;
  onReloadSessions: () => void;
  tab: BrowserTab | null;
  settings: Settings;
  onSettings: (settings: Settings) => void;
  onAccess: (id: number, sessionId: number, mode: "sftp" | "exec" | "local", sudo: boolean) => void;
  onPath: (id: number, path: string) => void;
}
export function Sidebar({ onMultiExec, active, onActive: setActive, onOpenSettings, onOpenFile, onStatus, onConnect, tab, settings, onSettings, onPath, onAccess, transferQueue, savedSessions, onSavedConnect, onEditSession, onReloadSessions }: Props) {
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [width, setWidth] = useState(() => clampPanel(loadWidth("werkterm.sidebar.width", DEFAULT_PANEL_WIDTH), window.innerWidth));
  useEffect(() => {
    const resized = () => { setWindowWidth(window.innerWidth); setWidth(current => clampPanel(current, window.innerWidth)); };
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, []);
  const resize = (next: number) => { const value = clampPanel(next, window.innerWidth); setWidth(value); storeWidth("werkterm.sidebar.width", value); };
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);
  const error = "Ungültige Adresse. Erwartet: [user@]host[:port], IPv6 in […], Port 1–65535.";
  return <aside className="sidebar" style={{ "--sidebar-width": width + "px" } as CSSProperties} aria-label="Sitzungen und SSH-Browser">
    <form className="quick-connect" onSubmit={event => { event.preventDefault(); const valid = parseQuickConnect(input) !== null; setInvalid(!valid); if (valid) { onConnect(input.trim()); setInput(""); } else onStatus(error); }}>
      <input aria-label="Quick connect" placeholder="Quick connect..." value={input} aria-invalid={invalid} title={invalid ? error : "[user@]host[:port]"} onChange={event => { setInput(event.target.value); setInvalid(false); }} />
    </form>
    <div className="sidebar-content"><nav className="sidebar-icons" aria-label="Seitenbereiche">{panels.map((panel, index) => <button type="button" key={panel.name} aria-label={panel.name} aria-pressed={active === index} title={panel.name} onClick={() => setActive(index)}><Icon name={panel.icon} /></button>)}</nav>
      <section className="sidebar-panel" aria-label={panels[active].name}><h2>{panels[active].name}</h2>
        {active === 0 ? <SessionsPanel sessions={savedSessions} onConnect={onSavedConnect} onEdit={onEditSession} onReload={onReloadSessions} onStatus={onStatus} /> : active === 3 ? <FileBrowser onOpenFile={onOpenFile} key={tab?.id ?? "none"} tab={tab} settings={settings} onSettings={onSettings} onPath={onPath} onAccess={onAccess} onStatus={onStatus} transferQueue={transferQueue} /> : active === 1 ? <div className="tools-panel"><button onClick={onOpenSettings}>Einstellungen…</button><button onClick={onMultiExec}>MultiExec</button></div> : <p className="empty-state">{panels[active].placeholder}</p>}
      </section>
    </div>
    <ResizeGrip className="sidebar-resize" label="Seitenpanel-Breite" value={width} min={260} max={Math.max(260, windowWidth * .6)} onResize={resize} onAuto={() => resize(DEFAULT_PANEL_WIDTH)} />
  </aside>;
}
