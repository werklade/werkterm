import { Icon, type IconName } from "./Icon";
import type { ShellKind } from "../lib/pty";

export function Toolbar({ hasWsl, onOpen, onSession, onTools }: { hasWsl: boolean; onOpen: (kind: ShellKind) => void; onSession(): void; onTools(): void }) {
  const items: { label: string; icon: IconName; kind?: ShellKind }[] = [
    { label: "Terminal", icon: "terminal", kind: "local" },
    ...(hasWsl ? [{ label: "WSL", icon: "tux" as const, kind: "wsl" as const }] : []),
    { label: "Sessions", icon: "star" }, { label: "Tools", icon: "tools" }, { label: "Macros", icon: "macros" },
  ];
  return <div className="toolbar" aria-label="Werkzeugleiste">{items.map(item => <button key={item.label} type="button" className="toolbar-button" aria-label={item.label} aria-disabled={item.label === "Macros" || undefined} title={item.label === "Macros" ? "Makros folgen in einer späteren Version" : item.label} onClick={() => { if (item.kind) onOpen(item.kind); else if (item.label === "Sessions") onSession(); else if (item.label === "Tools") onTools(); }}><Icon name={item.icon} /><span>{item.label}</span></button>)}</div>;
}
