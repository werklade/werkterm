import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import licenseText from "../../LICENSE?raw";
import { useModal } from "./useModal";
import { shortcuts } from "../lib/menu";
import { updateInfo } from "../lib/update";
import { describeInstall } from "../lib/updateState";
export function HelpDialog({ about, onClose }: { about: boolean; onClose(): void }) {
  const dialog = useModal();
  const [version, setVersion] = useState("wird geladen…");
  const [license, setLicense] = useState(false);
  const [install, setInstall] = useState("");
  useEffect(() => { if (about) void getVersion().then(setVersion).catch(() => setVersion("nicht verfügbar")); }, [about]);
  // update_info is local (no network); a missing command just leaves the line without the install kind.
  useEffect(() => { if (about) void updateInfo().then(info => setInstall(describeInstall(info))).catch(() => setInstall("")); }, [about]);
  return <dialog ref={dialog} className="ssh-dialog" aria-label={about ? "Über Werkterm" : "Tastenkürzel"} onCancel={e => { e.preventDefault(); onClose(); }}>
    <h2>{about ? "Über Werkterm" : "Tastenkürzel"}</h2>{about ? <><p>Werkterm {version}{install && ` (${install})`}</p><p>Lizenz: GPL-3.0-or-later</p><p>Unabhängiges Projekt, keine Verbindung zu Mobatek/MobaXterm</p><ul>{["Tauri (MIT/Apache-2.0)", "russh (Apache-2.0)", "xterm.js (MIT)", "CodeMirror (MIT)", "React (MIT)", "Tabler Icons (MIT)", "keyring (MIT/Apache-2.0)", "portable-pty (MIT)"].map(component => <li key={component}>{component}</li>)}</ul><a className="license-link" href="#werkterm-license" onClick={e => { e.preventDefault(); setLicense(!license); }}>LICENSE-Datei</a>{license && <pre id="werkterm-license" className="license-text">{licenseText}</pre>}</> : <><dl>{shortcuts.map(entry => <div key={entry.action}><dt>{entry.label}</dt><dd>{entry.shortcut}</dd></div>)}</dl><p>F10: erstes Menü fokussieren, auch aus Terminal und Editor. Alt-Kombinationen bleiben dort für Shell bzw. Editor verfügbar. Außerhalb von Terminal und Editor gilt Alt+T / Alt+S / Alt+V / Alt+O / Alt+H: Menüs öffnen. Pfeiltasten: navigieren. Enter/Leertaste: ausführen. Esc: schließen.</p><p>Editor: Strg+S Speichern, Strg+F Suchen, Strg+H Ersetzen, Strg+Z Rückgängig, Strg+Umschalt+Z Wiederholen.</p></>}
    <div className="dialog-actions"><button autoFocus onClick={onClose}>Schließen</button></div>
  </dialog>;
}
