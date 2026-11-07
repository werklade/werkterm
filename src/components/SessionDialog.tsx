import { useEffect, useId, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { keyringAvailable, saveSession, type SavedSession, type SessionAuth } from "../lib/sessions";
import { useModal } from "./useModal";
import "./SessionDialog.css";

interface Props {
  session?: SavedSession;
  sessions: SavedSession[];
  onClose: () => void;
  onSaved: (session: SavedSession) => void;
}

export function SessionDialog({ session, sessions, onClose, onSaved }: Props) {
  const dialog = useModal();
  const id = useId();
  const [name, setName] = useState(session?.name ?? "");
  const [folder, setFolder] = useState(session?.folder ?? "");
  const [host, setHost] = useState(session?.host ?? "");
  const [port, setPort] = useState(String(session?.port ?? 22));
  const [user, setUser] = useState(session?.user ?? "");
  const [authType, setAuthType] = useState<SessionAuth["type"]>(session?.auth.type ?? "default");
  const [keyPath, setKeyPath] = useState(session?.auth.type === "keyFile" ? session.auth.path : "");
  const [password, setPassword] = useState("");
  const [keyring, setKeyring] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void keyringAvailable().then(value => { if (active) setKeyring(value); }, () => { if (active) setKeyring(false); });
    return () => { active = false; };
  }, []);
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
        <label>Anmeldung<select value={authType} onChange={event => { setAuthType(event.target.value as SessionAuth["type"]); clearPassword(); }}>
          <option value="default">Standard (Agent/~/.ssh)</option><option value="keyFile">Schlüsseldatei</option>
          <option value="password" disabled={keyring !== true}>Passwort (im Schlüsselbund)</option><option value="ask">Beim Verbinden fragen</option>
        </select></label>
        {keyring !== true && <p className="session-hint">{keyring === null ? "Schlüsselbund wird geprüft…" : "Schlüsselbund nicht verfügbar: Passwortspeicherung ist deaktiviert."}</p>}
        {authType === "keyFile" && <label>Schlüsseldatei<div className="session-path-field"><input required value={keyPath} onChange={event => setKeyPath(event.target.value)} /><button type="button" title="Schlüsseldatei auswählen" onClick={() => void browse()}>Durchsuchen…</button></div></label>}
        {authType === "password" && <label>Passwort<input type="password" autoComplete="off" disabled={keyring !== true} value={password} onChange={event => setPassword(event.target.value)} />
          {session?.id && <span className="session-hint">Leer lassen, um das vorhandene Passwort zu behalten.</span>}</label>}
      </fieldset>
      {error && <p role="alert" className="session-error">{error}</p>}
      <div className="dialog-actions"><button type="submit" disabled={!valid || busy}>{busy ? "Speichern…" : "Speichern"}</button><button type="button" disabled={busy} onClick={cancel}>Abbrechen</button></div>
    </form>
  </dialog>;
}
