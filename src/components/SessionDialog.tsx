import { useEffect, useId, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { initialSessionAuthType, keyringAvailable, saveSession, type SavedSession, type SessionAuth } from "../lib/sessions";
import { useModal } from "./useModal";
import "./SessionDialog.css";

interface Props {
  session?: SavedSession;
  preferPassword?: boolean;
  sessions: SavedSession[];
  onClose: () => void;
  onSaved: (session: SavedSession) => void;
}

export function SessionDialog({ session, preferPassword = false, sessions, onClose, onSaved }: Props) {
  const dialog = useModal();
  const id = useId();
  const [name, setName] = useState(session?.name ?? "");
  const [folder, setFolder] = useState(session?.folder ?? "");
  const [host, setHost] = useState(session?.host ?? "");
  const [port, setPort] = useState(String(session?.port ?? 22));
  const [user, setUser] = useState(session?.user ?? "");
  const [authType, setAuthType] = useState<SessionAuth["type"]>(() => initialSessionAuthType(session, preferPassword, false));
  const authChanged = useRef(false);
  const [keyPath, setKeyPath] = useState(session?.auth.type === "keyFile" ? session.auth.path : "");
  const [password, setPassword] = useState("");
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
    void keyringAvailable().then(resolve, () => resolve(false));
    return () => { active = false; };
  }, [session, preferPassword]);
  const folders = new Set<string>();
  for (const saved of sessions) {
    const parts = saved.folder.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const validPort = /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  const valid = name.trim().length > 0 && host.length > 0 && !/[\s\p{Cc}]/u.test(host)
    && validPort && (authType !== "keyFile" || keyPath.trim().length > 0);
  const clearPassword = () => {
    setPassword("");
    const input = dialog.current?.querySelector<HTMLInputElement>('input[type="password"]');
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
      const secret = authType === "password" && password !== "" ? password : null;
      clearPassword();
      setBusy(true); setError("");
      void saveSession({ id: session?.id ?? "", name: name.trim(), folder: folder.trim(), host,
        port: Number(port), user: user.trim() || null,
        auth: authType === "keyFile" ? { type: "keyFile", path: keyPath } : { type: authType },
        source: session?.source ?? null }, secret).then(onSaved, () => {
        setError("Sitzung konnte nicht gespeichert werden. Bitte Eingaben und Schlüsselbund prüfen.");
        setBusy(false);
      });
    }}>
      <h2 id={`${id}-title`}>{session?.id ? "Sitzung bearbeiten" : "Neue Sitzung"}</h2>
      <fieldset disabled={busy} className="session-fields">
        <label>Name<input autoFocus required value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Ordner<input list={`${id}-folders`} value={folder} onChange={event => setFolder(event.target.value)} placeholder="z. B. Arbeit/Server" /></label>
        <datalist id={`${id}-folders`}>{[...folders].sort().map(path => <option key={path} value={path} />)}</datalist>
        <div className="session-target-fields"><label>Host<input required value={host} onChange={event => setHost(event.target.value)} /></label>
          <label>Port<input required type="number" min="1" max="65535" value={port} onChange={event => setPort(event.target.value)} /></label></div>
        <label>Benutzer<input value={user} onChange={event => setUser(event.target.value)} placeholder="Beim Verbinden eingeben" /></label>
        <div role="radiogroup" aria-labelledby={`${id}-auth-label`} className="session-auth">
          <span id={`${id}-auth-label`}>Anmeldung</span>
          {([
            ["default", "Standard (Agent/~/.ssh)", "SSH-Agent und Standardschlüssel im Ordner ~/.ssh verwenden."],
            ["keyFile", "Schlüsseldatei", "Eine bestimmte private SSH-Schlüsseldatei verwenden."],
            ["password", "Passwort (im Schlüsselbund)", "Das Passwort sicher im Schlüsselbund dieses Geräts speichern."],
            ["ask", "Beim Verbinden fragen", "Das Passwort bei jeder Verbindung eingeben."],
          ] as const).map(([type, label, hint]) => <div className="session-auth-option" key={type}>
            <label className="session-auth-choice"><input type="radio" name={`${id}-auth`} value={type}
              checked={authType === type} disabled={type === "password" && keyring !== true}
              aria-describedby={`${id}-${type}-hint${type === "password" && keyring !== true ? ` ${id}-keyring-hint` : ""}`}
              onChange={() => { authChanged.current = true; setAuthType(type); clearPassword(); }} />
              <span>{label}</span>
              {type === "password" && keyring !== true && <span id={`${id}-keyring-hint`} className="session-hint">{keyring === null ? "Schlüsselbund wird geprüft…" : "Schlüsselbund nicht verfügbar: Passwortspeicherung ist deaktiviert."}</span>}
            </label>
            <p id={`${id}-${type}-hint`} className="session-hint">{hint}</p>
            {type === "keyFile" && authType === type && <div className="session-auth-input"><label htmlFor={`${id}-key-path`}>Schlüsseldatei</label><div className="session-path-field"><input id={`${id}-key-path`} required value={keyPath} onChange={event => setKeyPath(event.target.value)} /><button type="button" title="Schlüsseldatei auswählen" onClick={() => void browse()}>Durchsuchen…</button></div></div>}
            {type === "password" && authType === type && <label className="session-auth-input">Passwort<input type="password" autoComplete="off" disabled={keyring !== true} value={password} onChange={event => setPassword(event.target.value)} />
              {session?.id && <span className="session-hint">Leer lassen, um das vorhandene Passwort zu behalten.</span>}</label>}
          </div>)}
        </div>
      </fieldset>
      {error && <p role="alert" className="session-error">{error}</p>}
      <div className="dialog-actions"><button type="submit" disabled={!valid || busy}>{busy ? "Speichern…" : "Speichern"}</button><button type="button" disabled={busy} onClick={cancel}>Abbrechen</button></div>
    </form>
  </dialog>;
}
