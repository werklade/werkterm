import { useEffect, useId, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { initialSessionAuthType, keyringAvailable, saveSession, type SavedSession, type SessionAuth } from "../lib/sessions";
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

export function SessionDialog({ session, preferPassword = false, sessions, onClose, onSaved }: Props) {
  const dialog = useModal();
  const id = useId();
  const [name, setName] = useState(session?.name ?? "");
  const [folder, setFolder] = useState(session?.folder ?? "");
  const [host, setHost] = useState(session?.host ?? "");
  const [keepaliveInterval, setKeepaliveInterval] = useState(session?.keepaliveInterval ?? 30);
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
    void keyringAvailable().then(resolve, reason => {
      if (!active) return;
      resolve(false);
      setError(sessionSaveError(reason));
    });
    return () => { active = false; };
  }, [session, preferPassword]);
  const folders = new Set<string>();
  for (const saved of sessions) {
    const parts = saved.folder.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const validPort = /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  const valid = name.trim().length > 0 && host.length > 0 && !/[\s\p{Cc}]/u.test(host)
    && Number.isInteger(keepaliveInterval) && keepaliveInterval >= 0 && keepaliveInterval <= 3600
    && Number.isInteger(keepaliveMax) && keepaliveMax >= 1 && keepaliveMax <= 100
    && validPort && (authType !== "keyFile" || keyPath.trim().length > 0);
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
      const secret = authType === "password" && password.value !== "" ? password.value : null;
      clearPassword();
      setBusy(true); setError("");
      void saveSession({ kind: session?.kind ?? "ssh", id: session?.id ?? "", name: name.trim(), folder: folder.trim(), host,
        port: Number(port), keepaliveInterval, keepaliveMax, user: user.trim() || null,
        auth: authType === "keyFile" ? { type: "keyFile", path: keyPath } : { type: authType },
        source: session?.source ?? null }, secret).then(onSaved, reason => {
        setError(sessionSaveError(reason));
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
        <label>Anmeldung<select value={authType} onChange={event => { authChanged.current = true; setAuthType(event.target.value as SessionAuth["type"]); clearPassword(); }}>
          <option value="default">Standard (Agent/~/.ssh)</option><option value="keyFile">Schlüsseldatei</option>
          <option value="password" disabled={keyring !== true}>Passwort (im Schlüsselbund)</option><option value="ask">Beim Verbinden fragen</option>
        </select></label>
        {keyring === false && <p className="session-hint">Schlüsselbund nicht verfügbar: Passwortspeicherung ist deaktiviert.</p>}
        {authType === "keyFile" && <label>Schlüsseldatei<div className="session-path-field"><input required value={keyPath} onChange={event => setKeyPath(event.target.value)} /><button type="button" title="Schlüsseldatei auswählen" onClick={() => void browse()}>Durchsuchen…</button></div></label>}
        {authType === "password" && <label>Passwort<PasswordField autoComplete="off" disabled={keyring !== true} value={password.value} visible={password.visible} onToggle={password.toggle} onChange={event => password.change(event.target.value)} />
          {session?.id && <span className="session-hint">Leer lassen, um das vorhandene Passwort zu behalten.</span>}</label>}
        <details><summary>Erweitert</summary><p>Keepalive erkennt unterbrochene Verbindungen. Intervall 0 schaltet es aus.</p><label>Intervall (Sekunden)<input type="number" required min={0} max={3600} value={keepaliveInterval} onChange={e => setKeepaliveInterval(Number(e.target.value))} /></label><label>Unbeantwortete Keepalives<input type="number" required min={1} max={100} value={keepaliveMax} onChange={e => setKeepaliveMax(Number(e.target.value))} /></label></details>
      </fieldset>
      {error && <p role="alert" className="session-error">{error}</p>}
      <div className="dialog-actions"><button type="submit" disabled={!valid || busy}>{busy ? "Speichern…" : "Speichern"}</button><button type="button" disabled={busy} onClick={cancel}>Abbrechen</button></div>
    </form>
  </dialog>;
}

export function sessionSaveError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /\bKEYRING_[A-Z_]+:/.test(message)
    ? `${message}. Tipp: Anmeldung 'Beim Verbinden fragen' wählen`
    : message;
}
