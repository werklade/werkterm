import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { listLocalDir, listSshDir, type DirEntry, type DirListing } from "../lib/fs";
import { childPath, parentPath } from "../lib/paths";
import { formatSize } from "../lib/formatSize";
import type { Settings } from "../lib/settings";
import "./FileBrowser.css";

export interface BrowserTab {
  id: number;
  kind: "local" | "wsl" | "ssh";
  title: string;
  target?: string;
  sessionId?: number;
  cwd?: { host: string; path: string };
  browserPath: string;
  exited: boolean;
}

interface Props {
  tab: BrowserTab | null;
  settings: Settings;
  onSettings: (settings: Settings) => void;
  onPath: (id: number, path: string) => void;
  onStatus: (message: string) => void;
}

const actions: { icon: IconName; label: string; action?: "up" | "refresh" }[] = [
  { icon: "folder-up", label: "Ordner hoch", action: "up" },
  { icon: "download", label: "Herunterladen" }, { icon: "upload", label: "Hochladen" },
  { icon: "refresh", label: "Refresh", action: "refresh" },
  { icon: "folder-new", label: "Neuer Ordner" }, { icon: "file-new", label: "Neue Datei" },
  { icon: "delete", label: "Löschen" }, { icon: "permissions", label: "Berechtigungen" }, { icon: "edit", label: "Bearbeiten" },
];
const settingLabels: { key: keyof Settings; label: string; title: string }[] = [
  { key: "followTerminalFolder", label: "Follow Terminal Folder", title: "Browser folgt dem Terminalverzeichnis" },
  { key: "shellIntegration", label: "Shell-Integration", title: "OSC 7 in neuen lokalen und WSL-Sitzungen aktivieren" },
  { key: "sshPromptCommand", label: "SSH PROMPT_COMMAND", title: "OSC 7 einmalig in neuen SSH-Sitzungen aktivieren" },
];
const isDirectory = (entry: DirEntry) => entry.kind === "dir" || (entry.kind === "symlink" && entry.targetIsDir);

export function FileBrowser({ tab, settings, onSettings, onPath, onStatus }: Props) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [input, setInput] = useState(tab?.browserPath ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const request = useRef(0);
  const callbacks = useRef({ onPath, onStatus });
  callbacks.current = { onPath, onStatus };
  const id = tab?.id;
  const kind = tab?.kind;
  const path = tab?.browserPath ?? "";
  const sessionId = tab?.sessionId;
  const distro = kind === "wsl" ? tab?.cwd?.host : undefined;
  const ready = tab !== null && (kind !== "ssh" || (sessionId !== undefined && !tab.exited)) && (kind !== "wsl" || Boolean(distro));

  useEffect(() => {
    setInput(path);
    const current = ++request.current;
    setListing(null);
    setError("");
    setLoading(ready);
    if (!ready || id === undefined) return;
    const pending = kind === "ssh" && sessionId !== undefined
      ? listSshDir(sessionId, path)
      : listLocalDir(path, distro ?? null);
    void pending.then(result => {
      if (request.current !== current) return;
      setListing(result);
      setInput(result.path);
      setLoading(false);
      if (result.path !== path) callbacks.current.onPath(id, result.path);
    }).catch((reason: unknown) => {
      if (request.current !== current) return;
      const message = `Verzeichnis konnte nicht geladen werden: ${String(reason)}`;
      setLoading(false);
      setError(message);
      callbacks.current.onStatus(message);
    });
    return () => { ++request.current; };
  }, [id, kind, path, sessionId, distro, ready, revision]);

  const navigate = (next: string) => {
    if (!tab || !ready) return;
    // Invalidate in-flight work before React commits the new navigation.
    ++request.current;
    setInput(next);
    onPath(tab.id, next);
    setRevision(value => value + 1);
  };
  const heading = !tab ? "Keine aktive Sitzung" : kind === "ssh"
    ? `SSH: ${tab.title}${listing ? ` (${listing.mode === "sftp" ? "SFTP" : "exec"})` : ""}`
    : kind === "wsl" ? `WSL: ${distro ?? "…"}` : "Lokal";
  const notice = !tab ? "Keine aktive Sitzung" : kind === "wsl" && !distro
    ? "Warte auf Verzeichnis der WSL-Sitzung…"
    : kind === "ssh" && !ready ? (tab.exited ? "SSH-Sitzung beendet" : "SSH-Verbindung wird aufgebaut…") : null;

  return <>
    <div className="browser-settings">{settingLabels.map(setting => <label key={setting.key} title={setting.title}><input type="checkbox" checked={settings[setting.key]} onChange={event => onSettings({ ...settings, [setting.key]: event.target.checked })} />{setting.label}</label>)}</div>
    <h3 className="browser-heading">{heading}</h3>
    <div className="browser-toolbar">{actions.map(action => <button key={action.icon} type="button" aria-label={action.label} title={action.label} disabled={!ready || !action.action} onClick={() => {
      if (action.action === "up") navigate(parentPath(listing?.path ?? path));
      if (action.action === "refresh") { ++request.current; setRevision(value => value + 1); }
    }}><Icon name={action.icon} /></button>)}</div>
    <form onSubmit={event => { event.preventDefault(); navigate(input); }}><input className="remote-path" aria-label="Browser-Pfad" placeholder="Pfad (leer: Home)" value={input} disabled={!ready} onChange={event => setInput(event.target.value)} /></form>
    {notice && <p className="empty-state">{notice}</p>}
    {loading && <p className="empty-state" role="status">Verzeichnis wird geladen…</p>}
    {error && <p className="browser-error" role="alert">{error}</p>}
    {listing && !loading && <div className="browser-list" aria-label="Verzeichnisinhalt"><table><thead><tr><th scope="col">Name</th><th scope="col">Größe</th><th scope="col">Geändert</th></tr></thead><tbody>{listing.entries.map(entry => <tr key={entry.name} tabIndex={0} aria-label={`${isDirectory(entry) ? "Ordner" : "Datei"}: ${entry.name}`} onDoubleClick={() => { if (isDirectory(entry)) navigate(childPath(listing.path, entry.name)); }} onKeyDown={event => { if (event.key === "Enter" && isDirectory(entry)) { event.preventDefault(); navigate(childPath(listing.path, entry.name)); } }}><td><span className="browser-entry-name"><Icon name={isDirectory(entry) ? "folder" : "file"} /><span title={entry.name}>{entry.name}</span></span></td><td>{isDirectory(entry) ? "—" : formatSize(entry.size)}</td><td>{entry.modified === null ? "—" : new Date(entry.modified * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</td></tr>)}</tbody></table>{listing.entries.length === 0 && <p className="empty-state">Leeres Verzeichnis</p>}</div>}
  </>;
}
