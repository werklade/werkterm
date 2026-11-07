import { useEffect, useRef, useState } from "react";
import { KindIcon } from "./KindIcon";
import { Icon } from "./Icon";
import { MenuBar } from "./MenuBar";
import type { ShellKind } from "../lib/pty";
import type { ConnectionKind } from "../lib/kindIcon";

export interface TerminalTab { id: number; kind: ConnectionKind; title: string; exited: boolean; tooltip?: string; dirty?: boolean; shell?: string; logPath?: string; connected?: boolean }
interface Props {
  onLogToggle?(id: number): void; onOpenLogFolder?(): void;
  showNumbers?: boolean; showClose?: boolean;
  tabs: TerminalTab[]; activeId: number | null; hasWsl: boolean;
  onSelect: (id: number) => void; onClose: (id: number) => void; onOpen: (kind: ShellKind) => void;
}
export function TabBar({ onLogToggle, onOpenLogFolder, tabs, activeId, hasWsl, onSelect, onClose, onOpen, showNumbers = false, showClose = true }: Props) {
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
  return <div className="tabbar"><div className="tabs" role="tablist" aria-label="Terminals und Editor"><div className={`tab ${activeId === 0 ? "active" : ""}`}><button type="button" role="tab" id="tab-home" aria-controls="home-panel" aria-selected={activeId === 0} onClick={() => onSelect(0)} title="Home"><Icon name="home"/><span>Home</span></button></div>{tabs.map((tab, index) => <div key={tab.id} onContextMenu={event => { event.preventDefault(); setContext({ id: tab.id, x: event.clientX, y: event.clientY }); }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }} onMouseDown={event => { if (event.button === 1) event.preventDefault(); }} className={`tab ${tab.id === activeId ? "active" : ""}`}><button type="button" role="tab" id={`tab-${tab.id}`} aria-controls={`${tab.kind === "editor" ? "editor" : tab.kind === "diff" ? "diff" : "terminal"}-${tab.id}`} aria-selected={tab.id === activeId} onClick={() => onSelect(tab.id)} title={tab.tooltip ?? tab.title}><KindIcon kind={tab.kind} shell={tab.shell}/><span>{showNumbers ? `${index + 1}. ` : ""}{tab.dirty ? "● " : ""}{tab.title}{tab.exited ? " (beendet)" : ""}</span>{tab.logPath && !tab.exited && <span className="log-indicator" title={`Protokoll: ${tab.logPath}`} aria-label={`Protokoll: ${tab.logPath}`}>●</span>}</button>{showClose && <button type="button" className="tab-close" aria-label={`${tab.title} schließen`} title="Tab schließen" onClick={() => onClose(tab.id)}>×</button>}</div>)}</div>
    <div className="new-tab"><button type="button" aria-label="Neues lokales Terminal" title="Neues lokales Terminal" onClick={() => onOpen("local")}>+</button>{hasWsl && <MenuBar menus={[{ label: "Shell auswählen", mnemonic: 0, items: [{ label: "Lokales Terminal", action: "local" }, { label: "WSL", action: "wsl" }] }]} toolbarIcon={<span aria-hidden="true">▾</span>} iconOnly onAction={action => onOpen(action === "wsl" ? "wsl" : "local")}/>}</div>
    {context && contextTab && <div ref={menu} role="menu" className="session-context" style={{ left: Math.min(context.x, window.innerWidth - 240), top: Math.min(context.y, window.innerHeight - 140) }} onKeyDown={event => {
      if (event.key === "Escape") { setContext(null); document.getElementById(`tab-${context.id}`)?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
    }}><button role="menuitem" disabled={contextTab.kind === "editor" || contextTab.kind === "diff" || contextTab.exited || contextTab.connected === false} onClick={() => { onLogToggle?.(context.id); setContext(null); }}>{contextTab.logPath ? "Protokoll stoppen" : "Protokoll starten"}</button><button role="menuitem" onClick={() => { onOpenLogFolder?.(); setContext(null); }}>Protokollordner öffnen</button><button role="menuitem" onClick={() => { onClose(context.id); setContext(null); }}>Tab schließen</button></div>}
  </div>;
}
