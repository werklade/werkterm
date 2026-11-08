import type { DiffSource } from "../lib/diff";
import { useEffect, useRef, useState } from "react";
import { PermissionsDialog } from "./PermissionsDialog";
import { SecretDialog } from "./SecretDialog";
import { BrowserContextMenu } from "./BrowserContextMenu";
import { changePermissions, countPermissionEntries, permissionRoute, disableSudo, enableSudo, modeToRwx, type ChmodOptions } from "../lib/permissions";
import { parseQuickConnect } from "../lib/quickConnect";
import { ResizeGrip } from "./ResizeGrip";
import { DEFAULT_COLUMNS, loadWidth, storeWidth, type ColumnWidths } from "../lib/browserWidths";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Icon, type IconName } from "./Icon";
import { FileActionDialog, type FileDialog } from "./FileActionDialog";
import { listLocalDir, listSshDir, type DirEntry, type DirListing } from "../lib/fs";
import { childPath, parentPath } from "../lib/paths";
import { formatSize } from "../lib/formatSize";
import { loadFileSort, saveFileSort, sortFileEntries, type FileSortColumn } from "../lib/fileSort";
import type { Settings } from "../lib/settings";
import { countEntries, createFile, deleteEntry, makeDirectory, remoteChild } from "../lib/transfers";
import type { TransferQueueHandle } from "../lib/transferQueue";
import "./FileBrowser.css";

export interface BrowserTab {
  id: number;
  kind: "local" | "wsl" | "ssh" | "telnet" | "serial" | "editor" | "diff" | "folderDiff";
  title: string;
  serial?: import("../lib/sessions").SerialConfig | null;
  target?: string;
  savedSessionId?: string;
  startCommand?: import("../lib/pty").StartCommand;
  saveDismissed?: boolean;
  sessionId?: number;
  cwd?: { host: string; path: string };
  browserPath: string;
  browserAccess?: { sessionId: number; mode: DirListing["mode"]; sudo: boolean };
  exited: boolean;
  /** Bumped on restart so the terminal view starts a fresh session. */
  generation?: number;
}
interface Props {
  tab: BrowserTab | null;
  settings: Settings;
  onSettings: (settings: Settings) => void;
  onPath: (id: number, path: string) => void;
  onAccess: (id: number, sessionId: number, mode: DirListing["mode"], sudo: boolean) => void;
  onStatus: (message: string) => void;
  markedSource?: DiffSource | null;
  onCompareFile?: (source: DiffSource, remember: boolean) => void;
  onOpenFile: (tab: BrowserTab, path: string) => void;
  transferQueue: TransferQueueHandle;
}
type BrowserPrompt = FileDialog
  | { type: "sudo"; label: string; answer: (secret: string | null) => void }
  | { type: "permissions"; entry: DirEntry; answer: (options: ChmodOptions | null) => void };
type Action = "sudo" | "chmod" | "up" | "refresh" | "download" | "upload" | "mkdir" | "create" | "delete" | "edit";
const actions: { icon: IconName; label: string; action?: Action }[] = [
  { icon: "folder-up", label: "Ordner hoch", action: "up" },
  { icon: "download", label: "Herunterladen", action: "download" },
  { icon: "upload", label: "Hochladen", action: "upload" },
  { icon: "refresh", label: "Refresh", action: "refresh" },
  { icon: "folder-new", label: "Neuer Ordner", action: "mkdir" },
  { icon: "file-new", label: "Neue Datei", action: "create" },
  { icon: "delete", label: "Löschen", action: "delete" },
  { icon: "permissions", label: "SSH-Browser mit sudo-Rechten", action: "sudo" }, { icon: "edit", label: "Öffnen im Editor", action: "edit" },
];
const settingLabels: { key: "followTerminalFolder" | "shellIntegration" | "sshPromptCommand"; label: string; title: string }[] = [
  { key: "followTerminalFolder", label: "Follow Terminal Folder", title: "Browser folgt dem Terminalverzeichnis" },
  { key: "shellIntegration", label: "Shell-Integration", title: "OSC 7 in neuen lokalen und WSL-Sitzungen aktivieren" },
  { key: "sshPromptCommand", label: "SSH PROMPT_COMMAND", title: "OSC 7 einmalig in neuen SSH-Sitzungen aktivieren" },
];
const isDirectory = (entry: DirEntry) => entry.kind === "dir" || (entry.kind === "symlink" && entry.targetIsDir);

export function FileBrowser({ markedSource, onCompareFile, tab, settings, onSettings, onPath, onAccess, onStatus, onOpenFile, transferQueue }: Props) {
  const [widths, setWidths] = useState<ColumnWidths>(() => ({
    name: Math.max(100, loadWidth("werkterm.column.name", DEFAULT_COLUMNS.name)),
    size: Math.max(55, loadWidth("werkterm.column.size", DEFAULT_COLUMNS.size)),
    modified: Math.max(90, loadWidth("werkterm.column.modified", DEFAULT_COLUMNS.modified)),
  }));
  const resizeColumn = (column: FileSortColumn, value: number) => {
    setWidths(current => {
      const next = { ...current, [column]: value };
      // Name fills the remainder; its boundary transfers space to/from Size.
      if (column === "name") {
        const actual = listRef.current?.querySelector("th")?.getBoundingClientRect().width ?? current.name;
        next.size = Math.max(55, current.size + actual - value);
        storeWidth("werkterm.column.size", next.size);
      }
      storeWidth("werkterm.column." + column, value);
      return next;
    });
  };
  const autoColumn = (column: FileSortColumn) => {
    const index = { name: 0, size: 1, modified: 2 }[column];
    const list = listRef.current;
    if (!list) return;
    const canvas = document.createElement("canvas").getContext("2d");
    if (!canvas) return;
    const cells = Array.from(list.querySelectorAll<HTMLTableRowElement>("tr")).map(row => row.cells[index]).filter(Boolean);
    let width = { name: 100, size: 55, modified: 90 }[column];
    for (const cell of cells) {
      const rect = cell.getBoundingClientRect(), viewport = list.getBoundingClientRect();
      if (rect.bottom < viewport.top || rect.top > viewport.bottom) continue;
      canvas.font = getComputedStyle(cell).font;
      width = Math.max(width, Math.ceil(canvas.measureText(cell.textContent ?? "").width) + (column === "name" ? 38 : 20));
    }
    resizeColumn(column, width);
  };
  const cachedAccess = tab?.browserAccess?.sessionId === tab?.sessionId ? tab?.browserAccess : undefined;
  const [sudoActive, setSudoActive] = useState(cachedAccess?.sudo ?? false);
  const [browserMode, setBrowserMode] = useState<DirListing["mode"] | null>(cachedAccess?.mode ?? null);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [input, setInput] = useState(tab?.browserPath ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [context, setContext] = useState<{ entry: DirEntry; x: number; y: number } | null>(null);
  const [sort, setSort] = useState(loadFileSort);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [prompt, setPrompt] = useState<BrowserPrompt | null>(null);
  const [promptSequence, setPromptSequence] = useState(0);
  const promptRef = useRef<BrowserPrompt | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  const request = useRef(0);
  const callbacks = useRef({ onPath, onStatus, onAccess });
  callbacks.current = { onPath, onStatus, onAccess };
  const id = tab?.id;
  const kind = tab?.kind;
  const path = tab?.browserPath ?? "";
  const sessionId = tab?.sessionId;
  const distro = kind === "wsl" ? tab?.cwd?.host : undefined;
  const ready = tab !== null && (kind !== "ssh" || (sessionId !== undefined && !tab.exited)) && (kind !== "wsl" || Boolean(distro));

  useEffect(() => {
    setBrowserMode(cachedAccess?.mode ?? null);
    setSudoActive(cachedAccess?.sudo ?? false);
  }, [cachedAccess?.mode, cachedAccess?.sudo, sessionId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const pending = promptRef.current;
      if (pending?.type === "name" || pending?.type === "sudo" || pending?.type === "permissions") pending.answer(null);
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
      setBrowserMode(result.mode);
      setSudoActive(Boolean(result.sudo));
      if (kind === "ssh" && sessionId !== undefined) callbacks.current.onAccess(id, sessionId, result.mode, Boolean(result.sudo));
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
  const sudoReady = ready && kind === "ssh" && browserMode === "sftp";
  const writable = ready && kind === "ssh" && listing?.mode === "sftp" && !loading;
  const permissionsRoute = permissionRoute(listing?.mode, listing?.path ?? path, /Windows/i.test(navigator.userAgent), kind === "wsl");
  const permissionsReady = ready && !loading && permissionsRoute !== null && (permissionsRoute !== "sftp" || sessionId !== undefined);
  const selectedEntry = listing?.entries.find(entry => entry.name === selected);
  const sortedEntries = listing ? sortFileEntries(listing.entries, sort) : [];
  const editorReady = ready && !loading && (kind !== "ssh" || listing?.mode === "sftp");
  const openEntry = (entry: DirEntry) => {
    if (tab && listing && editorReady && !isDirectory(entry)) onOpenFile(tab, childPath(listing.path, entry.name));
  };
  const changeSort = (column: FileSortColumn) => {
    const next = { column, direction: sort.column === column && sort.direction === "asc" ? "desc" as const : "asc" as const };
    setSort(next);
    saveFileSort(next);
  };
  const disabledReason = kind !== "ssh" ? "Nur bei SSH-Sitzungen" : "Nur mit SFTP verfügbar";
  const refresh = () => { if (mounted.current) { ++request.current; setRevision(value => value + 1); } };
  const fail = (reason: unknown) => {
    if (!mounted.current) return;
    const message = String(reason).replace(/^SUDO_[A-Z_]+:\s*/, "");
    setError(message);
    callbacks.current.onStatus(message);
  };
  const ask = <T,>(make: (answer: (value: T) => void) => BrowserPrompt) => new Promise<T>(resolve => {
    const next = make(value => { promptRef.current = null; if (mounted.current) setPrompt(null); resolve(value); });
    promptRef.current = next;
    setPromptSequence(value => value + 1);
    setPrompt(next);
  });
  const run = async (work: () => Promise<void>) => {
    if ((!writable && !sudoReady && !permissionsReady) || operation.current) return;
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
  const perform = (action: Action | undefined, contextEntry?: DirEntry) => {
    if (action === "up") { navigate(parentPath(listing?.path ?? path)); return; }
    if (action === "refresh") { refresh(); return; }
    if (action === "edit") { const entry = contextEntry ?? selectedEntry; if (entry) openEntry(entry); return; }
    if (action === "chmod") {
      const entry = contextEntry ?? selectedEntry;
      if (!permissionsReady || !permissionsRoute || !listing || !entry || entry.kind === "symlink" || operation.current) return;
      const route = permissionsRoute, targetPath = childPath(listing.path, entry.name), targetId = sessionId;
      void run(async () => {
        const options = await ask<ChmodOptions | null>(answer => ({ type: "permissions", entry, answer }));
        if (!options || !mounted.current) return;
        if (options.recursive) {
          const count = await countPermissionEntries(route, targetId, targetPath);
          if (!mounted.current) return;
          const accepted = await ask<boolean>(answer => ({ type: "delete", message: `${count + 1} Einträge ändern? Symlinks werden übersprungen.`, confirmLabel: "Rechte ändern", answer }));
          if (!accepted || !mounted.current) return;
        }
        const result = await changePermissions(route, targetId, targetPath, options);
        const message = `${result.changed} geändert, ${result.failed} fehlgeschlagen${result.errors.length ? ` · Fehlerpfade: ${result.errors.join(", ")}` : ""}`;
        callbacks.current.onStatus(message);
        if (result.failed && mounted.current) setError(message);
      });
      return;
    }
    if ((action === "sudo" ? !sudoReady : !writable || !listing) || sessionId === undefined || operation.current) return;
    const targetId = sessionId;
    const targetDir = listing?.path ?? path;
    const entry = contextEntry ?? selectedEntry;
    void run(async () => {
      if (action === "sudo") {
        if (sudoActive) {
          await disableSudo(targetId);
          if (mounted.current) setSudoActive(false);
          if (id !== undefined) callbacks.current.onAccess(id, targetId, "sftp", false);
          callbacks.current.onStatus("sudo-Modus deaktiviert");
        } else {
          try { await enableSudo(targetId); }
          catch (reason: unknown) {
            if (!String(reason).startsWith("SUDO_PASSWORD:")) throw reason;
            const target = parseQuickConnect(tab?.target ?? "");
            const label = target ? `${target.user}@${target.host}` : tab?.title ?? "SSH-Sitzung";
            let secret = await ask<string | null>(answer => ({ type: "sudo", label, answer }));
            if (secret === null || !mounted.current) return;
            try { await enableSudo(targetId, secret); } finally { secret = null; }
          }
          if (mounted.current) setSudoActive(true);
          if (id !== undefined) callbacks.current.onAccess(id, targetId, "sftp", true);
          callbacks.current.onStatus("sudo-Modus aktiviert");
        }
      } else if (action === "upload") {
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
    <h3 className="browser-heading">{heading}{kind === "ssh" && ready && sudoActive && <span className="sudo-badge">sudo</span>}</h3>
    <div className="browser-toolbar">{actions.map(action => {
      const viewAction = action.action === "up" || action.action === "refresh";
      const missingSelection = (action.action === "download" || action.action === "delete") && !selectedEntry;
      const directoryDownload = action.action === "download" && selectedEntry && isDirectory(selectedEntry);
      const editAction = action.action === "edit";
      const sudoAction = action.action === "sudo";
      const disabled = sudoAction ? !sudoReady || busy : editAction ? !editorReady || busy || !selectedEntry || isDirectory(selectedEntry)
        : viewAction ? !ready : !writable || busy || !action.action || missingSelection || directoryDownload;
      const title = editAction ? (kind === "ssh" && !editorReady ? "Nur mit SFTP verfügbar" : action.label)
        : !viewAction && !(sudoAction ? sudoReady : writable) ? disabledReason : directoryDownload ? "Ordner-Download folgt später" : action.label;
      return <button key={action.icon} type="button" aria-label={action.action === "sudo" ? "sudo-Modus" : action.label} aria-pressed={action.action === "sudo" ? sudoActive : undefined} title={title} disabled={Boolean(disabled)} onClick={() => perform(action.action)}><Icon name={action.icon} /></button>;
    })}</div>
    <form onSubmit={event => { event.preventDefault(); navigate(input); }}><input className="remote-path" aria-label="Browser-Pfad" placeholder="Pfad (leer: Home)" value={input} disabled={!ready} onChange={event => setInput(event.target.value)} /></form>
    {notice && <p className="empty-state">{notice}</p>}
    {loading && <p className="empty-state" role="status">Verzeichnis wird geladen…</p>}
    {error && <p className="browser-error" role="alert">{error}</p>}
    {listing && !loading && <div ref={listRef} className={`browser-list${dragOver ? " browser-drop-active" : ""}`} aria-label="Verzeichnisinhalt"><table style={{ minWidth: widths.name + widths.size + widths.modified }}><colgroup><col /><col style={{ width: widths.size }} /><col style={{ width: widths.modified }} /></colgroup><thead><tr>{([{ column: "name", label: "Name" }, { column: "size", label: "Größe" }, { column: "modified", label: "Geändert" }] as const).map(header => <th key={header.column} scope="col" aria-sort={sort.column === header.column ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}><button type="button" onClick={() => changeSort(header.column)}>{header.label}{sort.column === header.column && <span aria-hidden="true"> {sort.direction === "asc" ? "▲" : "▼"}</span>}</button><ResizeGrip label={header.label + "-Spaltenbreite"} value={widths[header.column]} measure={() => listRef.current?.querySelectorAll("th")[{ name: 0, size: 1, modified: 2 }[header.column]]?.getBoundingClientRect().width ?? widths[header.column]} min={header.column === "name" ? 100 : header.column === "size" ? 55 : 90} onResize={value => resizeColumn(header.column, value)} onAuto={() => autoColumn(header.column)} /></th>)}</tr></thead><tbody>{sortedEntries.map((entry, index) => <tr key={entry.name} title={modeToRwx(entry.permissions)} onContextMenu={event => { if ((!writable && !editorReady) || busy) return; event.preventDefault(); setSelected(entry.name); setContext({ entry, x: event.clientX, y: event.clientY }); }} tabIndex={selected === entry.name || (!selected && index === 0) ? 0 : -1} aria-selected={selected === entry.name} className={selected === entry.name ? "browser-selected" : ""} aria-label={`${isDirectory(entry) ? "Ordner" : "Datei"}: ${entry.name}`} onClick={() => setSelected(entry.name)} onFocus={() => setSelected(entry.name)} onDoubleClick={() => { if (isDirectory(entry)) navigate(childPath(listing.path, entry.name)); else openEntry(entry); }} onKeyDown={event => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        if ((writable || editorReady) && !busy) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setSelected(entry.name); setContext({ entry, x: rect.left + 12, y: rect.bottom }); }
      }
      if (event.key === "Enter") { event.preventDefault(); if (isDirectory(entry)) navigate(childPath(listing.path, entry.name)); else openEntry(entry); }
      if (event.key === "Delete") { event.preventDefault(); if (writable && !busy) perform("delete"); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = Math.max(0, Math.min(sortedEntries.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
        setSelected(sortedEntries[next].name);
        listRef.current?.querySelectorAll<HTMLTableRowElement>("tbody tr")[next]?.focus();
      }
    }}><td><span className="browser-entry-name"><Icon name={isDirectory(entry) ? "folder" : "file"} /><span title={entry.name}>{entry.name}</span></span></td><td>{isDirectory(entry) ? "—" : formatSize(entry.size)}</td><td>{entry.modified === null ? "—" : new Date(entry.modified * 1000).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "")}</td></tr>)}</tbody></table>{listing.entries.length === 0 && <p className="empty-state">Leeres Verzeichnis</p>}</div>}
    {context && <BrowserContextMenu {...context} permissionsDisabled={!permissionsReady} permissionsTitle={permissionsRoute === null && listing?.mode === "local" ? "Unix-Rechte sind hier nicht änderbar" : "Nur mit SFTP verfügbar"} markedName={markedSource ? markedSource.path.split(/[\\/]/).pop() : undefined} onAnswer={action => { const entry = context.entry; setContext(null); if ((action === "remember" || action === "compare") && tab && listing) onCompareFile?.({ tab, path: childPath(listing.path, entry.name) }, action === "remember"); else if (action && action !== "remember" && action !== "compare") perform(action, entry); }} />}
    {prompt?.type === "sudo" ? <SecretDialog key={promptSequence} title={`sudo-Passwort für ${prompt.label}`} prompt={{ type: "secret", requestId: 0, kind: "password", label: prompt.label }} onAnswer={prompt.answer} />
      : prompt?.type === "permissions" ? <PermissionsDialog key={promptSequence} entry={prompt.entry} onAnswer={prompt.answer} />
      : prompt && <FileActionDialog key={promptSequence} prompt={prompt} />}
  </>;
}
