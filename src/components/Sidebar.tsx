import { useState } from "react";
import { Icon, type IconName } from "./Icon";
import { parseQuickConnect } from "../lib/quickConnect";
import { FileBrowser, type BrowserTab } from "./FileBrowser";
import type { TransferStatus } from "../lib/transfers";
import type { Settings } from "../lib/settings";

export type { BrowserTab } from "./FileBrowser";

const panels: { name: string; icon: IconName; placeholder: string }[] = [
  { name: "Sessions", icon: "star", placeholder: "Noch keine gespeicherten Sitzungen." },
  { name: "Tools", icon: "tools", placeholder: "Werkzeuge folgen in einer späteren Phase." },
  { name: "Macros", icon: "macros", placeholder: "Noch keine Makros vorhanden." },
  { name: "SSH-Browser", icon: "globe", placeholder: "Keine SSH-Sitzung verbunden" },
];
interface Props {
  onStatus: (message: string) => void;
  onTransfer: (status: TransferStatus | null) => void;
  onConnect: (target: string) => void;
  tab: BrowserTab | null;
  settings: Settings;
  onSettings: (settings: Settings) => void;
  onPath: (id: number, path: string) => void;
}
export function Sidebar({ onStatus, onConnect, tab, settings, onSettings, onPath, onTransfer }: Props) {
  const [active, setActive] = useState(3);
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);
  const error = "Ungültige Adresse. Erwartet: user@host[:port], Port 1–65535.";
  return <aside className="sidebar" aria-label="Sitzungen und SSH-Browser">
    <form className="quick-connect" onSubmit={event => { event.preventDefault(); const valid = parseQuickConnect(input) !== null; setInvalid(!valid); if (valid) { onConnect(input.trim()); setInput(""); } else onStatus(error); }}>
      <input aria-label="Quick connect" placeholder="Quick connect..." value={input} aria-invalid={invalid} title={invalid ? error : "user@host[:port]"} onChange={event => { setInput(event.target.value); setInvalid(false); }} />
    </form>
    <div className="sidebar-content"><nav className="sidebar-icons" aria-label="Seitenbereiche">{panels.map((panel, index) => <button type="button" key={panel.name} aria-label={panel.name} aria-pressed={active === index} title={panel.name} onClick={() => setActive(index)}><Icon name={panel.icon} /></button>)}</nav>
      <section className="sidebar-panel" aria-label={panels[active].name}><h2>{panels[active].name}</h2>
        {active === 3 ? <FileBrowser key={tab?.id ?? "none"} tab={tab} settings={settings} onSettings={onSettings} onPath={onPath} onStatus={onStatus} onTransfer={onTransfer} /> : <p className="empty-state">{panels[active].placeholder}</p>}
      </section>
    </div>
  </aside>;
}
