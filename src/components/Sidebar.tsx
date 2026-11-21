import type { DiffSource } from "../lib/diff";
import { useEffect, useState, type CSSProperties } from "react";
import { ResizeGrip } from "./ResizeGrip";
import { DEFAULT_PANEL_WIDTH } from "../lib/browserWidths";
import { SessionsPanel } from "./SessionsPanel";
import type { SavedSession } from "../lib/sessions";
import { Icon, type IconName } from "./Icon";
import { FileBrowser, type BrowserTab } from "./FileBrowser";
import type { TransferQueueHandle } from "../lib/transferQueue";
import type { Settings } from "../lib/settings";

export type { BrowserTab } from "./FileBrowser";

const panels: { name: TextKey; icon: IconName; placeholder: TextKey }[] = [
  { name: "sidebar.sessions", icon: "star", placeholder: "sidebar.placeholder.sessions" },
  { name: "sidebar.tools", icon: "tools", placeholder: "sidebar.placeholder.tools" },
  { name: "sidebar.macros", icon: "macros", placeholder: "sidebar.placeholder.macros" },
  { name: "sidebar.ssh", icon: "globe", placeholder: "sidebar.placeholder.ssh" },
];
import { useT, type TextKey } from "../i18n";
import type { MenuItem } from "./MenuBar";
const toolIcons: Partial<Record<string, IconName>> = {
  local: "terminal", root: "terminal", processes: "view", hardware: "tools", tux: "tux", openFile: "file", ascii: "edit", compareFiles: "edit",
  keygen: "permissions", ports: "globe", tunnels: "jump", multiexec: "multiexec", settings: "settings",
};
interface Props {
  width: number;
  onWidthChange(width: number): void;
  macrosPanel?: React.ReactNode;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Entries of the Tools menu, shown as the Tools panel. */
  toolItems?: MenuItem[];
  onToolAction?: (action: string) => void;
  onMultiExec: () => void;
  active: number; onActive(value: number): void; onOpenSettings(): void;
  onStatus: (message: string) => void;
  markedSource?: DiffSource | null;
  onCompareFile?: (source: DiffSource, remember: boolean) => void;
  onOpenFile: (tab: BrowserTab, path: string) => void;
  transferQueue: TransferQueueHandle;
  savedSessions: SavedSession[];
  onSavedConnect: (session: SavedSession) => void;
  onEditSession: (session?: SavedSession) => void;
  onReloadSessions: () => void;
  onSessionsDeleted?: (ids: string[]) => void;
  /** Empty session folders. */
  sessionFolders?: string[];
  onSessionsWritten?: () => void;
  onUndoable?: (message: string, undo: () => void) => void;
  tab: BrowserTab | null;
  settings: Settings;
  onSettings: (settings: Settings) => void;
  onAccess: (id: number, sessionId: number, mode: "sftp" | "exec" | "local", sudo: boolean) => void;
  onPath: (id: number, path: string) => void;
}
export function Sidebar({ width, onWidthChange: resize, macrosPanel, markedSource, onCompareFile, collapsed, onCollapsedChange: collapse, toolItems = [], onToolAction, onMultiExec, active, onActive: setActive, onOpenSettings, onOpenFile, onStatus, tab, settings, onSettings, onPath, onAccess, transferQueue, savedSessions, onSavedConnect, onEditSession, onReloadSessions, onSessionsDeleted, sessionFolders, onSessionsWritten, onUndoable }: Props) {
  const t = useT();
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  useEffect(() => { const resizeWindow = () => setWindowWidth(window.innerWidth); window.addEventListener("resize", resizeWindow); return () => window.removeEventListener("resize", resizeWindow); }, []);
  // Clicking the active section again collapses the panel to the icon strip, like MobaXterm.
  const choose = (index: number) => { if (index === active && !collapsed) collapse(true); else { collapse(false); setActive(index); } };
  return <aside className={`sidebar ${collapsed ? "collapsed" : ""}`} style={{ "--sidebar-width": width + "px" } as CSSProperties} aria-label={t("sidebar.label")}>
    <div className="sidebar-content"><nav className="sidebar-icons" aria-label={t("sidebar.sections")}>{panels.map((panel, index) => <button type="button" key={panel.name} aria-label={t(panel.name)} aria-pressed={!collapsed && active === index} aria-expanded={!collapsed} title={collapsed || active !== index ? t(panel.name) : t("sidebar.collapse", { name: t(panel.name) })} onClick={() => choose(index)}><Icon name={panel.icon} /></button>)}</nav>
      {!collapsed && <section className="sidebar-panel" aria-label={t(panels[active].name)}><h2>{t(panels[active].name)}</h2>
        {active === 0 ? <SessionsPanel sessions={savedSessions} folders={sessionFolders} onWritten={onSessionsWritten} onUndoable={onUndoable} onConnect={onSavedConnect} onEdit={onEditSession} onReload={onReloadSessions} onDeleted={onSessionsDeleted} onStatus={onStatus} /> : active === 3 ? (tab?.kind === "telnet" || tab?.kind === "serial") ? <p className="empty-state">{t("sidebar.noBrowser")}</p> : <FileBrowser markedSource={markedSource} onCompareFile={onCompareFile} onOpenFile={onOpenFile} key={tab?.id ?? "none"} tab={tab} settings={settings} onSettings={onSettings} onPath={onPath} onAccess={onAccess} onStatus={onStatus} transferQueue={transferQueue} /> : active === 1 ? <div className="tools-panel" role="menu" aria-label={t("menu.tools")}>{toolItems.length ? toolItems.map(item => item.separator ? <hr key={item.action} /> : item.heading ? <div key={item.action} className="tools-heading">{item.label}</div> : <button key={item.action} role="menuitem" disabled={item.disabled} title={item.tooltip ?? item.shortcut} onClick={() => onToolAction?.(item.action)}>{toolIcons[item.action] ? <Icon name={toolIcons[item.action]!} /> : <span className="tools-icon-space" />}<span className="tools-label">{item.label}</span>{item.checked && <span className="tools-check" aria-label={t("sidebar.active")}>✓</span>}</button>) : <><button onClick={onOpenSettings}>{t("menu.settings.open")}</button><button onClick={onMultiExec}>{t("menu.tools.multiexec")}</button></>}</div> : active === 2 ? macrosPanel : <p className="empty-state">{t(panels[active].placeholder)}</p>}
      </section>}
    </div>
    {!collapsed && <ResizeGrip reverse={settings.sidebarRight} className="sidebar-resize" label={t("sidebar.resize")} value={width} min={260} max={Math.max(260, windowWidth * .6)} onResize={resize} onAuto={() => resize(DEFAULT_PANEL_WIDTH)} />}
  </aside>;
}
