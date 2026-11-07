import { Icon } from "./Icon";
import { MenuBar } from "./MenuBar";
import type { ShellKind } from "../lib/pty";

export interface TerminalTab { id: number; kind: ShellKind | "ssh" | "editor"; title: string; exited: boolean; tooltip?: string; dirty?: boolean }
interface Props {
  showNumbers?: boolean; showClose?: boolean;
  tabs: TerminalTab[]; activeId: number | null; hasWsl: boolean;
  onSelect: (id: number) => void; onClose: (id: number) => void; onOpen: (kind: ShellKind) => void;
}
export function TabBar({ tabs, activeId, hasWsl, onSelect, onClose, onOpen, showNumbers = false, showClose = true }: Props) {
  return <div className="tabbar"><div className="tabs" role="tablist" aria-label="Terminals und Editor"><div className={`tab ${activeId === 0 ? "active" : ""}`}><button type="button" role="tab" id="tab-home" aria-controls="home-panel" aria-selected={activeId === 0} onClick={() => onSelect(0)} title="Home"><Icon name="home"/><span>Home</span></button></div>{tabs.map((tab, index) => <div key={tab.id} className={`tab ${tab.id === activeId ? "active" : ""}`}><button type="button" role="tab" id={`tab-${tab.id}`} aria-controls={`${tab.kind === "editor" ? "editor" : "terminal"}-${tab.id}`} aria-selected={tab.id === activeId} onClick={() => onSelect(tab.id)} title={tab.tooltip ?? tab.title}><span>{showNumbers ? `${index + 1}. ` : ""}{tab.dirty ? "● " : ""}{tab.title}{tab.exited ? " (beendet)" : ""}</span></button>{showClose && <button type="button" className="tab-close" aria-label={`${tab.title} schließen`} title="Tab schließen" onClick={() => onClose(tab.id)}>×</button>}</div>)}</div>
    <div className="new-tab"><button type="button" aria-label="Neues lokales Terminal" title="Neues lokales Terminal" onClick={() => onOpen("local")}>+</button>{hasWsl && <MenuBar menus={[{ label: "Shell auswählen", mnemonic: 0, items: [{ label: "Lokales Terminal", action: "local" }, { label: "WSL", action: "wsl" }] }]} toolbarIcon={<span aria-hidden="true">▾</span>} iconOnly onAction={action => onOpen(action === "wsl" ? "wsl" : "local")}/>}</div>
  </div>;
}
