import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Icon, type IconName } from "./Icon";
import { FileActionDialog, type FileDialog } from "./FileActionDialog";
import { listLocalDir, listSshDir, type DirEntry, type DirListing } from "../lib/fs";
import { childPath, parentPath } from "../lib/paths";
import { formatSize } from "../lib/formatSize";
import type { Settings } from "../lib/settings";
import { countEntries, createFile, deleteEntry, makeDirectory, remoteChild } from "../lib/transfers";
import type { TransferQueueHandle } from "../lib/transferQueue";
import "./FileBrowser.css";

export interface BrowserTab {
  id: number;
  kind: "local" | "wsl" | "ssh";
  title: string;
  target?: string;
  savedSessionId?: string;
  saveDismissed?: boolean;
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
  transferQueue: TransferQueueHandle;
}
type Action = "up" | "refresh" | "download" | "upload" | "mkdir" | "create" | "delete";
const actions: { icon: IconName; label: string; action?: Action }[] = [
  { icon: "folder-up", label: "Ordner hoch", action: "up" },
  { icon: "download", label: "Herunterladen", action: "download" },
  { icon: "upload", label: "Hochladen", action: "upload" },
  { icon: "refresh", label: "Refresh", action: "refresh" },
  { icon: "folder-new", label: "Neuer Ordner", action: "mkdir" },
  { icon: "file-new", label: "Neue Datei", action: "create" },
  { icon: "delete", label: "Löschen", action: "delete" },
  { icon: "permissions", label: "Berechtigungen" }, { icon: "edit", label: "Bearbeiten" },
];
const settingLabels: { key: keyof Settings; label: string; title: string }[] = [
  { key: "followTerminalFolder", label: "Follow Terminal Folder", title: "Browser folgt dem Terminalverzeichnis" },
  { key: "shellIntegration", label: "Shell-Integration", title: "OSC 7 in neuen lokalen und WSL-Sitzungen aktivieren" },
  { key: "sshPromptCommand", label: "SSH PROMPT_COMMAND", title: "OSC 7 einmalig in neuen SSH-Sitzungen aktivieren" },
];
const isDirectory = (entry: DirEntry) => entry.kind === "dir" || (entry.kind === "symlink" && entry.targetIsDir);

export function FileBrowser({ tab, settings, onSettings, onPath, onStatus, transferQueue }: Props) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [input, setInput] = useState(tab?.browserPath ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [prompt, setPrompt] = useState<FileDialog | null>(null);
  const [promptSequence, setPromptSequence] = useState(0);
  const promptRef = useRef<FileDialog | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
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
    mounted.current = true;
    return () => {
      mounted.current = false;
      const pending = promptRef.current;
      if (pending?.type === "name") pending.answer(null);
      else if (pending?.type === "delete") pending.answer(false);
    };
  }, []);
  useEffect(() => {
    setSelected(null);
    setInput(path);
    const current = ++request.current;
    setListing(null);
    setError("");
    setLoading(ready);
    if (!ready || id === undefined) return;
    const pending = kind === "ssh" && sessionId !== undefined ? listSshDir(sessionId, path) : listLocalDir(path, distro ?? null);
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
    ++request.current;
    setInput(next);
    onPath(tab.id, next);
    setRevision(value => value + 1);
  };
  const writable = ready && kind === "ssh" && listing?.mode === "sftp" && !loading;
  const selectedEntry = listing?.entries.find(entry => entry.name === selected);
  const disabledReason = kind !== "ssh" ? "Nur bei SSH-Sitzungen" : "Nur mit SFTP verfügbar";
  const refresh = () => { if (mounted.current) { ++request.current; setRevision(value => value + 1); } };
  const fail = (reason: unknown) => {
    if (!mounted.current) return;
    const message = String(reason);
    setError(message);
    callbacks.current.onStatus(message);
  };
  const ask = <T,>(make: (answer: (value: T) => void) => FileDialog) => new Promise<T>(resolve => {
    const next = make(value => { promptRef.current = null; if (mounted.current) setPrompt(null); resolve(value); });
    promptRef.current = next;
    setPromptSequence(value => value + 1);
    setPrompt(next);
  });
  const run = async (work: () => Promise<void>) => {
    if (!writable || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    try { await work(); } catch (reason: unknown) { fail(reason); }
    finally {
      operation.current = false;
      if (mounted.current) { setBusy(false); refresh(); }
    }
  };
  const uploadPaths = (paths: string[]) => {
    if (sessionId === undefined || !listing) return;
    transferQueue.enqueue(paths.map(localPath => ({ kind: "upload", sessionId, localPath, remoteDir: listing.path })));
  };
  useEffect(() => transferQueue.onFinished(event => {
    if (event.sessionId === sessionId && event.dir === (listing?.path ?? path)) setRevision(value => value + 1);
  }), [transferQueue, sessionId, listing?.path, path]);
  const perform = (action: Action | undefined) => {
    if (action === "up") { navigate(parentPath(listing?.path ?? path)); return; }
    if (action === "refresh") { refresh(); return; }
    if (!writable || sessionId === undefined || !listing || operation.current) return;
    const targetId = sessionId;
    const targetDir = listing.path;
    const entry = selectedEntry;
    void run(async () => {
      if (action === "upload") {
        const paths = await open({ multiple: true, directory: false, title: "Dateien auswählen" });
        if (paths) transferQueue.enqueue(paths.map(localPath => ({ kind: "upload", sessionId: targetId, localPath, remoteDir: targetDir })));
      } else if (action === "download" && entry && !isDirectory(entry)) {
        const localPath = await save({ defaultPath: entry.name, title: "Datei speichern" });
        if (!localPath) return;
        transferQueue.enqueue([{ kind: "download", sessionId: targetId, remotePath: remoteChild(targetDir, entry.name), localPath }]);
      } else if (action === "mkdir" || action === "create") {
        const name = await ask<string | null>(answer => ({ type: "name", directory: action === "mkdir", answer }));
        if (name === null || !mounted.current) return;
        await (action === "mkdir" ? makeDirectory : createFile)(targetId, targetDir, name);
      } else if (action === "delete" && entry) {
        const remotePath = remoteChild(targetDir, entry.name);
        const count = entry.kind === "dir" ? await countEntries(targetId, remotePath) : null;
        if (!mounted.current) return;
        const message = count === null ? `${entry.name} wirklich löschen?` : `Ordner ${entry.name} mit ${count > 100000 ? "100000+" : count} Einträgen endgültig löschen?`;
        const accepted = await ask<boolean>(answer => ({ type: "delete", message, answer }));
        if (accepted && mounted.current) await deleteEntry(targetId, remotePath, entry.kind === "dir");
      }
    });
  };
  const dropHandler = useRef({ writable, busy, uploadPaths, fail });
  dropHandler.current = { writable, busy, uploadPaths, fail };
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(event => {
      if (disposed) return;
      const payload = event.payload;
      if (payload.type === "leave") { setDragOver(false); return; }
      const rect = listRef.current?.getBoundingClientRect();
      const x = payload.position.x / window.devicePixelRatio;
      const y = payload.position.y / window.devicePixelRatio;
      const inside = Boolean(rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
      const active = inside && dropHandler.current.writable && !dropHandler.current.busy;
      setDragOver(active && payload.type !== "drop");
      if (payload.type === "drop" && active) dropHandler.current.uploadPaths(payload.paths);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch((reason: unknown) => { if (!disposed) dropHandler.current.fail(reason); });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const heading = !tab ? "Keine aktive Sitzung" : kind === "ssh"
    ? `SSH: ${tab.title}${listing ? ` (${listing.mode === "sftp" ? "SFTP" : "exec"})` : ""}`
    : kind === "wsl" ? `WSL: ${distro ?? "…"}` : "Lokal";
  const notice = !tab ? "Keine aktive Sitzung" : kind === "wsl" && !distro
    ? "Warte auf Verzeichnis der WSL-Sitzung…"
    : kind === "ssh" && !ready ? (tab.exited ? "SSH-Sitzung beendet" : "SSH-Verbindung wird aufgebaut…") : null;

  return <>
    <div className="browser-settings">{settingLabels.map(setting => <label key={setting.key} title={setting.title}><input type="checkbox" checked={settings[setting.key]} onChange={event => onSettings({ ...settings, [setting.key]: event.target.checked })} />{setting.label}</label>)}</div>
    <h3 className="browser-heading">{heading}</h3>
    <div className="browser-toolbar">{actions.map(action => {
      const viewAction = action.action === "up" || action.action === "refresh";
      const missingSelection = (action.action === "download" || action.action === "delete") && !selectedEntry;
      const directoryDownload = action.action === "download" && selectedEntry && isDirectory(selectedEntry);
      const disabled = viewAction ? !ready : !writable || busy || !action.action || missingSelection || directoryDownload;
      const title = !viewAction && !writable ? disabledReason : directoryDownload ? "Ordner-Download folgt später" : action.label;
      return <button key={action.icon} type="button" aria-label={action.label} title={title} disabled={Boolean(disabled)} onClick={() => perform(action.action)}><Icon name={action.icon} /></button>;
    })}</div>
    <form onSubmit={event => { event.preventDefault(); navigate(input); }}><input className="remote-path" aria-label="Browser-Pfad" placeholder="Pfad (leer: Home)" value={input} disabled={!ready} onChange={event => setInput(event.target.value)} /></form>
    {notice && <p className="empty-state">{notice}</p>}
    {loading && <p className="empty-state" role="status">Verzeichnis wird geladen…</p>}
    {error && <p className="browser-error" role="alert">{error}</p>}
    {listing && !loading && <div ref={listRef} className={`browser-list${dragOver ? " browser-drop-active" : ""}`} aria-label="Verzeichnisinhalt"><table><colgroup><col /><col className="browser-size-column" /><col className="browser-date-column" /></colgroup><thead><tr><th scope="col">Name</th><th scope="col">Größe</th><th scope="col">Geändert</th></tr></thead><tbody>{listing.entries.map((entry, index) => <tr key={entry.name} tabIndex={selected === entry.name || (!selected && index === 0) ? 0 : -1} aria-selected={selected === entry.name} className={selected === entry.name ? "browser-selected" : ""} aria-label={`${isDirectory(entry) ? "Ordner" : "Datei"}: ${entry.name}`} onClick={() => setSelected(entry.name)} onFocus={() => setSelected(entry.name)} onDoubleClick={() => { if (isDirectory(entry)) navigate(childPath(listing.path, entry.name)); }} onKeyDown={event => {
      if (event.key === "Enter" && isDirectory(entry)) { event.preventDefault(); navigate(childPath(listing.path, entry.name)); }
      if (event.key === "Delete") { event.preventDefault(); if (writable && !busy) perform("delete"); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = Math.max(0, Math.min(listing.entries.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
        setSelected(listing.entries[next].name);
        listRef.current?.querySelectorAll<HTMLTableRowElement>("tbody tr")[next]?.focus();
      }
    }}><td><span className="browser-entry-name"><Icon name={isDirectory(entry) ? "folder" : "file"} /><span title={entry.name}>{entry.name}</span></span></td><td>{isDirectory(entry) ? "—" : formatSize(entry.size)}</td><td>{entry.modified === null ? "—" : new Date(entry.modified * 1000).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "")}</td></tr>)}</tbody></table>{listing.entries.length === 0 && <p className="empty-state">Leeres Verzeichnis</p>}</div>}
    {prompt && <FileActionDialog key={promptSequence} prompt={prompt} />}
  </>;
}
