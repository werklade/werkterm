import { keyringErrorText } from "../lib/keyringErrors";
import { invoke } from "@tauri-apps/api/core";
import { defaultSerial, validateSession, type SerialConfig } from "../lib/sessions";
import { useEffect, useId, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { initialSessionAuthType, jumpHostOptions, sessionLabel, keyringAvailable, saveSession, type SavedSession, type SessionAuth } from "../lib/sessions";
import { useModal } from "./useModal";
import { PasswordField } from "./PasswordField";
import { usePasswordInput } from "../lib/passwordInput";
import "./SessionDialog.css";

interface Props {
  session?: SavedSession;
  preferPassword?: boolean;
  sessions: SavedSession[];
  onClose: () => void;
  onSaved: (session: SavedSession) => void;
}

const standardBauds = [300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
export function SessionDialog({ session, preferPassword = false, sessions, onClose, onSaved }: Props) {
  const dialog = useModal();
  const id = useId();
  const [kind, setKind] = useState(session?.kind ?? "ssh");
  const [serial, setSerial] = useState<SerialConfig>(session?.serial ?? { ...defaultSerial });
  const [baudCustom, setBaudCustom] = useState(() => !standardBauds.includes(serial.baud));
  const [ports, setPorts] = useState<{ name: string; description: string }[]>([]);
  const refreshPorts = () => { void invoke<{ name: string; description: string }[]>("serial_ports").then(setPorts, reason => setError(String(reason))); };
  useEffect(() => { if (kind === "serial") refreshPorts(); }, [kind]);
  const [logAlways, setLogAlways] = useState(session?.log_always ?? false);
  const [name, setName] = useState(session?.name ?? "");
  const [folder, setFolder] = useState(session?.folder ?? "");
  const [host, setHost] = useState(session?.host ?? "");
  const [keepaliveInterval, setKeepaliveInterval] = useState(session?.keepaliveInterval ?? 30);
  const [jumpSessionId, setJumpSessionId] = useState(session?.jumpSessionId ?? "");
  const jumpOptions = jumpHostOptions(sessions, session?.id);
  const [keepaliveMax, setKeepaliveMax] = useState(session?.keepaliveMax ?? 3);
  const [port, setPort] = useState(String(session?.port ?? 22));
  const [user, setUser] = useState(session?.user ?? "");
  const [authType, setAuthType] = useState<SessionAuth["type"]>(() => initialSessionAuthType(session, preferPassword, false));
  const authChanged = useRef(false);
  const [keyPath, setKeyPath] = useState(session?.auth.type === "keyFile" ? session.auth.path : "");
  const password = usePasswordInput();
  const [keyring, setKeyring] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const resolve = (value: boolean) => {
      if (!active) return;
      setKeyring(value);
      if (!authChanged.current) setAuthType(initialSessionAuthType(session, preferPassword, value));
    };
    void keyringAvailable().then(resolve, () => {
      if (!active) return;
      resolve(false);
    });
    return () => { active = false; };
  }, [session, preferPassword]);
  const folders = new Set<string>();
  for (const saved of sessions) {
    const parts = saved.folder.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const draft: SavedSession = { kind, id: session?.id ?? "", name: name.trim(), folder: folder.trim(), host: kind === "serial" ? "" : host,
    port: kind === "serial" ? 23 : Number(port), user: user.trim() || null, serial: kind === "serial" ? serial : null,
    keepaliveInterval: kind === "ssh" ? keepaliveInterval : 30, keepaliveMax: kind === "ssh" ? keepaliveMax : 3,
    jumpSessionId: kind === "ssh" ? jumpSessionId || null : null, log_always: logAlways,
    auth: kind !== "ssh" ? { type: "default" } : authType === "keyFile" ? { type: "keyFile", path: keyPath } : { type: authType }, source: session?.source ?? null };
  const valid = validateSession(draft) === null && (kind !== "ssh" || !jumpSessionId || jumpOptions.some(hop => hop.id === jumpSessionId));
  const clearPassword = () => {
    password.reset();
    const input = dialog.current?.querySelector<HTMLInputElement>('.password-field input');
    if (input) input.value = "";
  };
  const cancel = () => { if (!busy) { clearPassword(); onClose(); } };
  const browse = async () => {
    try {
      const path = await open({ directory: false, multiple: false, title: "SSH-Schlüsseldatei auswählen" });
      if (typeof path === "string") setKeyPath(path);
    } catch { setError("Schlüsseldatei konnte nicht ausgewählt werden."); }
  };
  return <dialog ref={dialog} className="ssh-dialog session-dialog" aria-modal="true" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); cancel(); }}>
    <form autoComplete="off" onSubmit={event => {
      event.preventDefault();
      if (!valid || busy) return;
      const secret = kind === "ssh" && authType === "password" && password.value !== "" ? password.value : null;
      clearPassword();
      setBusy(true); setError("");
      void saveSession(draft, secret).then(onSaved, reason => {
        setError(sessionSaveError(reason));
        setBusy(false);
      });
    }}>
      <h2 id={`${id}-title`}>{session?.id ? "Sitzung bearbeiten" : "Neue Sitzung"}</h2>
      <fieldset disabled={busy} className="session-fields">
        <label>Art<select value={kind} onChange={event => { const next = event.target.value; setKind(next); setPort(next === "telnet" ? "23" : "22"); clearPassword(); }}><option value="ssh">SSH</option><option value="telnet">Telnet</option><option value="serial">Seriell</option></select></label>
        <label>Name<input autoFocus required value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Ordner<input list={`${id}-folders`} value={folder} onChange={event => setFolder(event.target.value)} placeholder="z. B. Arbeit/Server" /></label>
        <datalist id={`${id}-folders`}>{[...folders].sort().map(path => <option key={path} value={path} />)}</datalist>
        {kind !== "serial" && <><div className="session-target-fields"><label>Host<input required value={host} onChange={event => setHost(event.target.value)} /></label>
          <label>Port<input required type="number" min="1" max="65535" value={port} onChange={event => setPort(event.target.value)} /></label></div>
        <label>Benutzer<input value={user} onChange={event => setUser(event.target.value)} placeholder="Beim Verbinden eingeben" /></label>
        </>}
        {kind === "telnet" && <p role="note" className="session-hint">Telnet ist unverschlüsselt – Passwörter werden im Klartext übertragen.</p>}
        {kind === "serial" && <>
          <label>Port<div className="session-path-field"><input required list={`${id}-ports`} value={serial.device} placeholder="/dev/ttyUSB0 oder COM3" onChange={e => setSerial({ ...serial, device: e.target.value })}/><button type="button" onClick={refreshPorts}>Aktualisieren</button></div></label>
          <datalist id={`${id}-ports`}>{ports.map(port => <option key={port.name} value={port.name}>{port.description}</option>)}</datalist>
          <label>Baudrate<select value={baudCustom ? "custom" : String(serial.baud)} onChange={e => { const custom = e.target.value === "custom"; setBaudCustom(custom); if (!custom) setSerial({ ...serial, baud: Number(e.target.value) }); }}>
            {standardBauds.map(n => <option key={n} value={n}>{n}</option>)}<option value="custom">Andere…</option></select></label>
          {baudCustom && <label>Eigene Baudrate<input required type="number" min={1} max={4294967295} value={serial.baud} onChange={e => setSerial({ ...serial, baud: Number(e.target.value) })}/></label>}
          <label>Datenbits<select value={serial.data_bits} onChange={e => setSerial({ ...serial, data_bits: Number(e.target.value) })}>{[5,6,7,8].map(n => <option key={n}>{n}</option>)}</select></label>
          <label>Parität<select value={serial.parity} onChange={e => setSerial({ ...serial, parity: e.target.value as SerialConfig["parity"] })}><option value="none">Keine</option><option value="odd">Ungerade</option><option value="even">Gerade</option></select></label>
          <label>Stoppbits<select value={serial.stop_bits} onChange={e => setSerial({ ...serial, stop_bits: Number(e.target.value) })}><option>1</option><option>2</option></select></label>
          <label>Flusskontrolle<select value={serial.flow} onChange={e => setSerial({ ...serial, flow: e.target.value as SerialConfig["flow"] })}><option value="none">Keine</option><option value="software">Software (XON/XOFF)</option><option value="hardware">Hardware (RTS/CTS)</option></select></label>
          <label>Enter sendet<select value={serial.enter} onChange={e => setSerial({ ...serial, enter: e.target.value as SerialConfig["enter"] })}><option value="cr">CR</option><option value="lf">LF</option><option value="crlf">CRLF</option></select></label>
          <label><input type="checkbox" checked={serial.local_echo} onChange={e => setSerial({ ...serial, local_echo: e.target.checked })}/>Lokales Echo</label>
        </>}
        {kind === "ssh" && <><label>Anmeldung<select value={authType} onChange={event => { authChanged.current = true; setAuthType(event.target.value as SessionAuth["type"]); clearPassword(); }}>
          <option value="default">Standard (Agent/~/.ssh)</option><option value="keyFile">Schlüsseldatei</option>
          <option value="password" disabled={keyring !== true}>Passwort (im Schlüsselbund)</option><option value="ask">Beim Verbinden fragen</option>
        </select></label>
        {keyring === false && <p className="session-hint">Kein Schlüsselbund verfügbar – Passwort wird beim Verbinden abgefragt.</p>}
        {authType === "keyFile" && <label>Schlüsseldatei<div className="session-path-field"><input required value={keyPath} onChange={event => setKeyPath(event.target.value)} /><button type="button" title="Schlüsseldatei auswählen" onClick={() => void browse()}>Durchsuchen…</button></div></label>}
        {authType === "password" && <label>Passwort<PasswordField autoComplete="off" disabled={keyring !== true} value={password.value} visible={password.visible} onToggle={password.toggle} onChange={event => password.change(event.target.value)} />
          {session?.id && <span className="session-hint">Leer lassen, um das vorhandene Passwort zu behalten.</span>}</label>}
        </>}<details><summary>Erweitert</summary><label><input type="checkbox" checked={logAlways} onChange={e => setLogAlways(e.target.checked)} />Diese Sitzung immer protokollieren</label>
          {kind === "ssh" && <><label>Jump host<select value={jumpSessionId} onChange={event => setJumpSessionId(event.target.value)}>
            <option value="">(keiner)</option>
            {jumpOptions.map(hop => <option key={hop.id} value={hop.id}>{hop.name} ({sessionLabel(hop)})</option>)}
          </select></label>
          <small className="session-hint">Verbindung läuft über diese Sitzung (wie ssh -J).</small><p>Keepalive erkennt unterbrochene Verbindungen. Intervall 0 schaltet es aus.</p><label>Intervall (Sekunden)<input type="number" required min={0} max={3600} value={keepaliveInterval} onChange={e => setKeepaliveInterval(Number(e.target.value))} /></label><label>Unbeantwortete Keepalives<input type="number" required min={1} max={100} value={keepaliveMax} onChange={e => setKeepaliveMax(Number(e.target.value))} /></label></>}</details>
      </fieldset>
      {error && <p role="alert" className="session-error">{error}</p>}
      <div className="dialog-actions"><button type="submit" disabled={!valid || busy}>{busy ? "Speichern…" : "Speichern"}</button><button type="button" disabled={busy} onClick={cancel}>Abbrechen</button></div>
    </form>
  </dialog>;
}

export function sessionSaveError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return keyringErrorText(message);
}
