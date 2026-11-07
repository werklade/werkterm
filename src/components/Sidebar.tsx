import { useEffect, useState, type CSSProperties } from "react";
import { ResizeGrip } from "./ResizeGrip";
import { clampPanel, DEFAULT_PANEL_WIDTH, loadWidth, storeWidth } from "../lib/browserWidths";
import { SessionsPanel } from "./SessionsPanel";
import type { SavedSession } from "../lib/sessions";
import { Icon, type IconName } from "./Icon";
import { QuickConnect } from "./QuickConnect";
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
import type { MenuItem } from "./MenuBar";
const toolIcons: Partial<Record<string, IconName>> = {
  local: "terminal", root: "terminal", processes: "view", hardware: "tools", tux: "tux", openFile: "file", ascii: "edit",
  keygen: "permissions", ports: "globe", tunnels: "jump", multiexec: "multiexec", settings: "settings",
};
interface Props {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Entries of the Tools menu, shown as the Tools panel. */
  toolItems?: MenuItem[];
  onToolAction?: (action: string) => void;
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
export function Sidebar({ collapsed, onCollapsedChange: collapse, toolItems = [], onToolAction, onMultiExec, active, onActive: setActive, onOpenSettings, onOpenFile, onStatus, onConnect, tab, settings, onSettings, onPath, onAccess, transferQueue, savedSessions, onSavedConnect, onEditSession, onReloadSessions }: Props) {
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [width, setWidth] = useState(() => clampPanel(loadWidth("werkterm.sidebar.width", DEFAULT_PANEL_WIDTH), window.innerWidth));
  useEffect(() => {
    const resized = () => { setWindowWidth(window.innerWidth); setWidth(current => clampPanel(current, window.innerWidth)); };
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, []);
  const resize = (next: number) => { const value = clampPanel(next, window.innerWidth); setWidth(value); storeWidth("werkterm.sidebar.width", value); };
  // Clicking the active section again collapses the panel to the icon strip, like MobaXterm.
  const choose = (index: number) => { if (index === active && !collapsed) collapse(true); else { collapse(false); setActive(index); } };
  return <aside className={`sidebar ${collapsed ? "collapsed" : ""}`} style={{ "--sidebar-width": width + "px" } as CSSProperties} aria-label="Sitzungen und SSH-Browser">
    {!collapsed && <QuickConnect onConnect={onConnect} onStatus={onStatus} />}
    <div className="sidebar-content"><nav className="sidebar-icons" aria-label="Seitenbereiche">{panels.map((panel, index) => <button type="button" key={panel.name} aria-label={panel.name} aria-pressed={!collapsed && active === index} aria-expanded={!collapsed} title={collapsed || active !== index ? panel.name : `${panel.name} (einklappen)`} onClick={() => choose(index)}><Icon name={panel.icon} /></button>)}</nav>
      {!collapsed && <section className="sidebar-panel" aria-label={panels[active].name}><h2>{panels[active].name}</h2>
        {active === 0 ? <SessionsPanel sessions={savedSessions} onConnect={onSavedConnect} onEdit={onEditSession} onReload={onReloadSessions} onStatus={onStatus} /> : active === 3 ? (tab?.kind === "telnet" || tab?.kind === "serial") ? <p className="empty-state">Für Telnet/Seriell nicht verfügbar</p> : <FileBrowser onOpenFile={onOpenFile} key={tab?.id ?? "none"} tab={tab} settings={settings} onSettings={onSettings} onPath={onPath} onAccess={onAccess} onStatus={onStatus} transferQueue={transferQueue} /> : active === 1 ? <div className="tools-panel" role="menu" aria-label="Tools">{toolItems.length ? toolItems.map(item => item.separator ? <hr key={item.action} /> : item.heading ? <div key={item.action} className="tools-heading">{item.label}</div> : <button key={item.action} role="menuitem" disabled={item.disabled} title={item.tooltip ?? item.shortcut} onClick={() => onToolAction?.(item.action)}>{toolIcons[item.action] ? <Icon name={toolIcons[item.action]!} /> : <span className="tools-icon-space" />}<span className="tools-label">{item.label}</span>{item.checked && <span className="tools-check" aria-label="aktiv">✓</span>}</button>) : <><button onClick={onOpenSettings}>Einstellungen…</button><button onClick={onMultiExec}>MultiExec</button></>}</div> : <p className="empty-state">{panels[active].placeholder}</p>}
      </section>}
    </div>
    {!collapsed && <ResizeGrip className="sidebar-resize" label="Seitenpanel-Breite" value={width} min={260} max={Math.max(260, windowWidth * .6)} onResize={resize} onAuto={() => resize(DEFAULT_PANEL_WIDTH)} />}
  </aside>;
}
