import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { buildSessionTree, collectFolderSessions, deleteSessions, selectSessions, jumpHostHint, searchSessions, sessionLabel, type SavedSession, type SessionFolder } from "../lib/sessions";
import { KindIcon } from "./KindIcon";
import { Icon } from "./Icon";
import { FileActionDialog } from "./FileActionDialog";
import { ImportDialog } from "./ImportDialog";
import "./SessionsPanel.css";

interface Props {
  sessions: SavedSession[];
  onConnect: (session: SavedSession) => void;
  onEdit: (session?: SavedSession) => void;
  onReload: () => void;
  onStatus: (message: string) => void;
}
type Row = { key: string; depth: number; folder?: SessionFolder; session?: SavedSession; parent?: string };
function loadExpanded(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse((localStorage.getItem("werkterm.sessionFolders") ?? localStorage.getItem("linmoba.sessionFolders")) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch { /* Storage may be unavailable. */ }
  return {};
}
export function SessionsPanel({ sessions, onConnect, onEdit, onReload, onStatus }: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(loadExpanded);
  const [selected, setSelected] = useState("");
  const [selection, setSelection] = useState({ ids: [] as string[], anchor: "" });
  const [deleting, setDeleting] = useState<SavedSession[] | null>(null);
  const [importSource, setImportSource] = useState<"mobaxterm" | "windterm" | null>(null);
  const [importMenu, setImportMenu] = useState(false);
  const [context, setContext] = useState<{ x: number; y: number; row: Row } | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const preserveSelectionOnFocus = useRef(false);
  useEffect(() => { try { localStorage.setItem("werkterm.sessionFolders", JSON.stringify(expanded)); } catch { /* Storage may be unavailable. */ } }, [expanded]);
  useEffect(() => {
    if (!context) return;
    contextRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => { if (!contextRef.current?.contains(event.target as Node)) setContext(null); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [context]);
  const rows: Row[] = [];
  const append = (folder: SessionFolder, depth: number, parent?: string) => {
    for (const child of folder.folders) {
      const key = `folder:${child.path}`;
      rows.push({ key, depth, folder: child, parent });
      if (query || expanded[child.path]) append(child, depth + 1, key);
    }
    for (const session of folder.sessions) rows.push({ key: `session:${session.id}`, depth, session, parent });
  };
  append(buildSessionTree(searchSessions(sessions, query)), 0);
  const visibleIds = rows.flatMap(row => row.session ? [row.session.id] : []);
  const selectedSessions = sessions.filter(session => selection.ids.includes(session.id) && visibleIds.includes(session.id));
  const current = selectedSessions.length === 1 ? selectedSessions[0] : undefined;
  const choose = (row: Row, action: "single" | "toggle" | "range" = "single") => {
    setSelected(row.key);
    setSelection(previous => selectSessions(previous, visibleIds, row.session?.id ?? "", action));
  };
  const folderSessions = (folder: SessionFolder) => {
    const find = (node: SessionFolder): SessionFolder | undefined => node.path === folder.path ? node : node.folders.map(find).find(Boolean);
    const full = find(buildSessionTree(sessions));
    return full ? collectFolderSessions(full) : [];
  };
  const toggle = (path: string, value?: boolean) => setExpanded(previous => ({ ...previous, [path]: value ?? !previous[path] }));
  const focus = (key: string, extend = false) => { const row = rows.find(item => item.key === key); if (row) choose(row, extend ? "range" : "single"); preserveSelectionOnFocus.current = true; rowRefs.current.get(key)?.focus(); preserveSelectionOnFocus.current = false; };
  const keyDown = (event: KeyboardEvent, row: Row, index: number) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      focus(rows[next].key, event.shiftKey);
    } else if (event.key === "ArrowRight" && row.folder) { event.preventDefault(); if (!expanded[row.folder.path]) toggle(row.folder.path, true); else if (rows[index + 1]?.parent === row.key) focus(rows[index + 1].key); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); if (row.folder && expanded[row.folder.path]) toggle(row.folder.path, false); else if (row.parent) focus(row.parent); }
    else if (event.key === "Enter") { event.preventDefault(); if (row.session) onConnect(row.session); else if (row.folder) toggle(row.folder.path); }
    else if (event.key === "Delete" && selectedSessions.length > 0) { event.preventDefault(); setDeleting(selectedSessions); }
  };
  return <div className="sessions-panel" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault(); setSelection(previous => selectSessions(previous, visibleIds, "", "all"));
    } else if (event.key === "Delete" && !event.defaultPrevented && !context && !deleting && selectedSessions.length > 0 && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault(); setDeleting(selectedSessions);
    } else if (event.key === "Escape" && !context && !deleting) {
      const row = rows.find(item => item.key === selected); if (row) choose(row);
    }
  }}>
    <div className="sessions-toolbar" aria-label="Sitzungsaktionen">
      <span aria-live="polite">{selectedSessions.length} ausgewählt</span>
      <button title="Neue Sitzung" aria-label="Neue Sitzung" onClick={() => onEdit()}><Icon name="file-new" /></button>
      <button title="Bearbeiten" aria-label="Bearbeiten" disabled={!current} onClick={() => onEdit(current)}><Icon name="edit" /></button>
      <button title="Löschen" aria-label="Löschen" disabled={!selectedSessions.length} onClick={() => setDeleting(selectedSessions)}><Icon name="delete" /></button>
      <button title="Importieren" aria-expanded={importMenu} onClick={() => setImportMenu(!importMenu)}>Importieren</button>
      <button title="Aktualisieren" aria-label="Aktualisieren" onClick={onReload}><Icon name="refresh" /></button>
    </div>
    {importMenu && <div className="sessions-import-menu"><button title="Aus MobaXterm importieren" onClick={() => { setImportMenu(false); setImportSource("mobaxterm"); }}>Aus MobaXterm…</button><button title="Aus WindTerm importieren" onClick={() => { setImportMenu(false); setImportSource("windterm"); }}>Aus WindTerm…</button></div>}
    <input className="sessions-search" aria-label="Sitzungen suchen" placeholder="Sitzungen suchen…" value={query} onChange={event => setQuery(event.target.value)} />
    <div className="sessions-list" role="tree" aria-multiselectable="true" aria-label="Gespeicherte Sitzungen">
      {rows.map((row, index) => <div key={row.key} ref={element => { if (element) rowRefs.current.set(row.key, element); else rowRefs.current.delete(row.key); }} title={row.session ? jumpHostHint(row.session, sessions) || undefined : undefined} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.folder ? Boolean(query || expanded[row.folder.path]) : undefined} aria-selected={row.session ? selectedSessions.some(session => session.id === row.session?.id) : selected === row.key} tabIndex={selected === row.key || (!rows.some(item => item.key === selected) && index === 0) ? 0 : -1} className="session-row" style={{ paddingLeft: 8 + row.depth * 14 }} onPointerDown={() => { preserveSelectionOnFocus.current = true; }} onPointerUp={() => { preserveSelectionOnFocus.current = false; }} onFocus={() => { setSelected(row.key); if (!preserveSelectionOnFocus.current && (selected !== row.key || selection.ids.length === 0)) choose(row); }} onClick={event => { choose(row, event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "single"); if (row.folder) toggle(row.folder.path); }} onDoubleClick={() => row.session && onConnect(row.session)} onKeyDown={event => keyDown(event, row, index)} onContextMenu={event => { event.preventDefault(); setSelected(row.key); if (row.session && !selectedSessions.some(session => session.id === row.session?.id)) choose(row); setContext({ x: event.clientX, y: event.clientY, row }); }}>
        <span aria-hidden="true">{row.folder ? query || expanded[row.folder.path] ? "▾" : "▸" : ""}</span>{row.folder ? <Icon name="folder" /> : <KindIcon kind={row.session?.kind ?? "ssh"} />}<span className="session-row-label">{row.folder?.name ?? row.session?.name}{row.session && <small title={[sessionLabel(row.session), jumpHostHint(row.session, sessions)].filter(Boolean).join(" – ")}>{sessionLabel(row.session)}{row.session.jumpSessionId && <> · <span className="jump-inline"><Icon name="jump" /></span> {jumpHostHint(row.session, sessions)}</>}</small>}</span>
      </div>)}
      {rows.length === 0 && <p className="empty-state">{query ? "Keine passenden Sitzungen." : "Noch keine gespeicherten Sitzungen."}</p>}
    </div>
    {context && <div ref={contextRef} className="session-context" role="menu" aria-label="Sitzungsaktionen" style={{ left: Math.min(context.x, window.innerWidth - 160), top: Math.min(context.y, window.innerHeight - 130) }} onKeyDown={event => { if (event.key === "Escape") { setContext(null); preserveSelectionOnFocus.current = true; rowRefs.current.get(context.row.key)?.focus(); preserveSelectionOnFocus.current = false; } if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const buttons = Array.from(contextRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus(); } }}>
      {context.row.session && <><button role="menuitem" onClick={() => { onConnect(context.row.session!); setContext(null); }}>Verbinden</button><button role="menuitem" disabled={selectedSessions.length !== 1} onClick={() => { onEdit(context.row.session); setContext(null); }}>Bearbeiten</button></>}
      <button role="menuitem" onClick={() => {
        setDeleting(context.row.folder ? folderSessions(context.row.folder) : selectedSessions);
        setContext(null);
      }}>{context.row.folder ? "Ordner mit allen Sitzungen löschen" : `${selectedSessions.length} Sitzungen löschen`}</button>
    </div>}
    {deleting && <FileActionDialog prompt={{ type: "delete", message: `${deleting.length} Sitzungen löschen?\n${deleting.slice(0, 10).map(session => session.name).join("\n")}${deleting.length > 10 ? `\n… und ${deleting.length - 10} weitere` : ""}\nGespeicherte Passwörter werden aus dem Schlüsselbund entfernt.`, answer: accepted => {
      const targets = deleting; setDeleting(null);
      if (accepted) void deleteSessions(targets.map(session => session.id)).then(result => {
        onReload();
        setSelection(previous => ({ ...previous, ids: previous.ids.filter(id => !result.deleted.includes(id)) }));
        onStatus([`${result.deleted.length}${result.blocked.length ? ` gelöscht, ${result.blocked.length} nicht gelöscht: ${result.blocked.map(item => `${item.name} (${item.reason})`).join(", ")}` : " Sitzungen gelöscht"}`, ...result.warnings].join("; "));
      }).catch(reason => { onReload(); onStatus(typeof reason === "string" ? reason : "Sitzungen konnten nicht gelöscht werden."); });
    } }} />}
    {importSource && <ImportDialog source={importSource} onClose={() => setImportSource(null)} onImported={result => { setImportSource(null); onReload(); onStatus([`${result.imported} Sitzungen importiert, ${result.skippedDuplicates} Duplikate übersprungen`, ...(result.warnings ?? [])].join("; ")); }} />}
  </div>;
}
