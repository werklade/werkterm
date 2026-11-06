import { useState } from "react";
import { Icon, type IconName } from "./Icon";
import { parseQuickConnect } from "../lib/quickConnect";

const panels: { name: string; icon: IconName; placeholder: string }[] = [
  { name: "Sessions", icon: "star", placeholder: "Noch keine gespeicherten Sitzungen." },
  { name: "Tools", icon: "tools", placeholder: "Werkzeuge folgen in einer späteren Phase." },
  { name: "Macros", icon: "macros", placeholder: "Noch keine Makros vorhanden." },
  { name: "SSH-Browser", icon: "globe", placeholder: "Keine SSH-Sitzung verbunden" },
];
const browserActions: { icon: IconName; label: string }[] = [
  { icon: "folder-up", label: "Übergeordneter Ordner" }, { icon: "download", label: "Herunterladen" },
  { icon: "upload", label: "Hochladen" }, { icon: "refresh", label: "Aktualisieren" },
  { icon: "folder-new", label: "Neuer Ordner" }, { icon: "file-new", label: "Neue Datei" },
  { icon: "delete", label: "Löschen" }, { icon: "permissions", label: "Berechtigungen" }, { icon: "edit", label: "Bearbeiten" },
];
export function Sidebar({ onStatus }: { onStatus: (message: string) => void }) {
  const [active, setActive] = useState(3);
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);
  const error = "Ungültige Adresse. Erwartet: user@host[:port], Port 1–65535.";
  return <aside className="sidebar" aria-label="Sitzungen und SSH-Browser">
    <form className="quick-connect" onSubmit={event => { event.preventDefault(); const valid = parseQuickConnect(input) !== null; setInvalid(!valid); if (valid) onStatus("SSH folgt in Phase 2"); }}>
      <input aria-label="Quick connect" placeholder="Quick connect..." value={input} aria-invalid={invalid} title={invalid ? error : "user@host[:port]"} onChange={event => { setInput(event.target.value); setInvalid(false); }} />
    </form>
    <div className="sidebar-content"><nav className="sidebar-icons" aria-label="Seitenbereiche">{panels.map((panel, index) => <button type="button" key={panel.name} aria-label={panel.name} aria-pressed={active === index} title={panel.name} onClick={() => setActive(index)}><Icon name={panel.icon} /></button>)}</nav>
      <section className="sidebar-panel" aria-label={panels[active].name}><h2>{panels[active].name}</h2>
        {active === 3 && <><div className="browser-toolbar">{browserActions.map(action => <span key={action.icon} title={`${action.label} – keine SSH-Sitzung verbunden`}><button type="button" disabled aria-label={action.label} title={`${action.label} – keine SSH-Sitzung verbunden`}><Icon name={action.icon} /></button></span>)}</div><input className="remote-path" aria-label="Remote-Pfad" placeholder="Remote-Pfad" list="remote-paths" disabled /><datalist id="remote-paths" /></>}
        <p className="empty-state">{panels[active].placeholder}</p>
      </section>
    </div>
  </aside>;
}
