import { useEffect, useRef, useState } from "react";
import { KindIcon } from "./KindIcon";
import { Icon } from "./Icon";
import { MenuBar } from "./MenuBar";
import type { ShellKind } from "../lib/pty";
import type { ConnectionKind } from "../lib/kindIcon";
import { useT } from "../i18n";

export interface TerminalTab { startCommand?: string; recording?: boolean; id: number; kind: ConnectionKind; title: string; exited: boolean; tooltip?: string; dirty?: boolean; shell?: string; logPath?: string; connected?: boolean }
interface Props {
  onLogToggle?(id: number): void; onOpenLogFolder?(): void;
  showNumbers?: boolean; showClose?: boolean;
  tabs: TerminalTab[]; activeId: number | null; hasWsl: boolean;
  onSelect: (id: number) => void; onClose: (id: number) => void; onOpen: (kind: ShellKind) => void;
}
export function TabBar({ onLogToggle, onOpenLogFolder, tabs, activeId, hasWsl, onSelect, onClose, onOpen, showNumbers = false, showClose = true }: Props) {
  const t = useT();
  const [context, setContext] = useState<{ id: number; x: number; y: number } | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!context) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setContext(null); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [context]);
  const contextTab = tabs.find(tab => tab.id === context?.id);
  return <div className="tabbar"><div className="tabs" role="tablist" aria-label={t("tabs.label")}><div className={`tab ${activeId === 0 ? "active" : ""}`}><button type="button" role="tab" id="tab-home" aria-controls="home-panel" aria-selected={activeId === 0} onClick={() => onSelect(0)} title={t("tab.home")}><Icon name="home"/><span>{t("tab.home")}</span></button></div>{tabs.map((tab, index) => <div key={tab.id} onContextMenu={event => { event.preventDefault(); setContext({ id: tab.id, x: event.clientX, y: event.clientY }); }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }} onMouseDown={event => { if (event.button === 1) event.preventDefault(); }} className={`tab ${tab.id === activeId ? "active" : ""}`}><button type="button" role="tab" id={`tab-${tab.id}`} aria-controls={`${tab.kind === "editor" ? "editor" : tab.kind === "folderDiff" ? "folderDiff" : tab.kind === "diff" ? "diff" : "terminal"}-${tab.id}`} aria-selected={tab.id === activeId} onClick={() => onSelect(tab.id)} title={tab.tooltip ?? tab.title}>{tab.startCommand === "hardware" ? <Icon name="tools"/> : tab.startCommand === "processes" ? <Icon name="view"/> : <KindIcon kind={tab.kind} shell={tab.shell}/>}{tab.recording && <span className="record-indicator" aria-label={t("tab.recording")}>●</span>}<span>{showNumbers ? `${index + 1}. ` : ""}{tab.dirty ? "● " : ""}{tab.title}{tab.exited ? ` (${t("tab.exited")})` : ""}</span>{tab.logPath && !tab.exited && <span className="log-indicator" title={t("tab.logIndicator", { path: tab.logPath })} aria-label={t("tab.logIndicator", { path: tab.logPath })}>●</span>}</button>{showClose && <button type="button" className="tab-close" aria-label={t("tab.closeNamed", { title: tab.title })} title={t("menu.terminal.close")} onClick={() => onClose(tab.id)}>×</button>}</div>)}</div>
    <div className="new-tab"><button type="button" aria-label={t("tab.newLocal")} title={t("tab.newLocal")} onClick={() => onOpen("local")}>+</button>{hasWsl && <MenuBar menus={[{ id: "shell", label: t("tab.chooseShell"), mnemonic: 0, items: [{ label: t("menu.terminal.local"), action: "local" },{ label: "WSL", action: "wsl" }] }]} toolbarIcon={<span aria-hidden="true">▾</span>} iconOnly onAction={action => onOpen(action === "wsl" ? "wsl" : "local")}/>}</div>
    {context && contextTab && <div ref={menu} role="menu" className="session-context" style={{ left: Math.min(context.x, window.innerWidth - 240), top: Math.min(context.y, window.innerHeight - 140) }} onKeyDown={event => {
      if (event.key === "Escape") { setContext(null); document.getElementById(`tab-${context.id}`)?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
    }}><button role="menuitem" disabled={contextTab.kind === "editor" || contextTab.kind === "diff" || contextTab.kind === "folderDiff" || contextTab.exited || contextTab.connected === false} onClick={() => { onLogToggle?.(context.id); setContext(null); }}>{contextTab.logPath ? t("menu.terminal.logStop") : t("menu.terminal.logStart")}</button><button role="menuitem" onClick={() => { onOpenLogFolder?.(); setContext(null); }}>{t("menu.terminal.logFolder")}</button><button role="menuitem" onClick={() => { onClose(context.id); setContext(null); }}>{t("menu.terminal.close")}</button></div>}
  </div>;
}
