import { useState } from "react";
import type { ShellKind } from "../lib/pty";

export interface TerminalTab { id: number; kind: ShellKind; title: string; exited: boolean }
interface Props {
  tabs: TerminalTab[]; activeId: number | null; hasWsl: boolean;
  onSelect: (id: number) => void; onClose: (id: number) => void; onOpen: (kind: ShellKind) => void;
}
export function TabBar({ tabs, activeId, hasWsl, onSelect, onClose, onOpen }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="tabbar"><div className="tabs" role="tablist" aria-label="Terminals">{tabs.map(tab => <div key={tab.id} className={`tab ${tab.id === activeId ? "active" : ""}`}><button type="button" role="tab" id={`tab-${tab.id}`} aria-controls={`terminal-${tab.id}`} aria-selected={tab.id === activeId} onClick={() => onSelect(tab.id)} title={tab.title}><span>{tab.title}{tab.exited ? " (beendet)" : ""}</span></button><button type="button" className="tab-close" aria-label={`${tab.title} schließen`} title="Tab schließen" onClick={() => onClose(tab.id)}>×</button></div>)}</div>
    <div className="new-tab"><button type="button" aria-label="Neues lokales Terminal" title="Neues lokales Terminal" onClick={() => onOpen("local")}>+</button>{hasWsl && <><button type="button" aria-label="Shell auswählen" title="Shell auswählen" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>▾</button>{menuOpen && <div className="shell-menu" onKeyDown={event => { if (event.key === "Escape") setMenuOpen(false); }}><button type="button" aria-label="WSL-Terminal öffnen" title="WSL-Terminal öffnen" onClick={() => { onOpen("wsl"); setMenuOpen(false); }}>WSL öffnen</button></div>}</>}</div>
  </div>;
}
