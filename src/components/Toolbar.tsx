import { MenuBar } from "./MenuBar";
import { toolsMenuItems } from "../lib/menu";
import { Icon, type IconName } from "./Icon";
import type { ShellKind } from "../lib/pty";

export function Toolbar({ hasWsl, onOpen, onSession, multiExec, onAction }: { hasWsl: boolean; onOpen: (kind: ShellKind) => void; onSession(): void; multiExec: boolean; onAction(action: string): void }) {
  const items: { label: string; icon: IconName; kind?: ShellKind }[] = [
    { label: "Terminal", icon: "terminal", kind: "local" },
    ...(hasWsl ? [{ label: "WSL", icon: "tux" as const, kind: "wsl" as const }] : []),
    { label: "Sessions", icon: "star" }, { label: "Tools", icon: "tools" }, { label: "Macros", icon: "macros" },
  ];
  return <div className="toolbar" aria-label="Werkzeugleiste">{items.map(item => item.label === "Tools" ? <MenuBar key="Tools" menus={[{ label: "Tools", mnemonic: 1, items: toolsMenuItems(multiExec) }]} onAction={onAction} toolbarIcon={<Icon name="tools" />} /> : <button key={item.label} type="button" className="toolbar-button" aria-label={item.label} aria-disabled={item.label === "Macros" || undefined} title={item.label === "Macros" ? "Makros folgen in einer späteren Version" : item.label} onClick={() => { if (item.kind) onOpen(item.kind); else if (item.label === "Sessions") onSession(); }}><Icon name={item.icon} /><span>{item.label}</span></button>)}</div>;
}
