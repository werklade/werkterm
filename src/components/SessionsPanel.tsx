import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { buildSessionTree, deleteSession, searchSessions, sessionLabel, type SavedSession, type SessionFolder } from "../lib/sessions";
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
    const parsed: unknown = JSON.parse(localStorage.getItem("linmoba.sessionFolders") ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch { /* Storage may be unavailable. */ }
  return {};
}
export function SessionsPanel({ sessions, onConnect, onEdit, onReload, onStatus }: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(loadExpanded);
  const [selected, setSelected] = useState("");
  const [deleting, setDeleting] = useState<SavedSession | null>(null);
  const [importSource, setImportSource] = useState<"mobaxterm" | "windterm" | null>(null);
  const [importMenu, setImportMenu] = useState(false);
  const [context, setContext] = useState<{ x: number; y: number; session: SavedSession } | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => { try { localStorage.setItem("linmoba.sessionFolders", JSON.stringify(expanded)); } catch { /* Storage may be unavailable. */ } }, [expanded]);
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
  const current = sessions.find(session => `session:${session.id}` === selected);
  const toggle = (path: string, value?: boolean) => setExpanded(previous => ({ ...previous, [path]: value ?? !previous[path] }));
  const focus = (key: string) => { setSelected(key); rowRefs.current.get(key)?.focus(); };
  const keyDown = (event: KeyboardEvent, row: Row, index: number) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      focus(rows[next].key);
    } else if (event.key === "ArrowRight" && row.folder) { event.preventDefault(); if (!expanded[row.folder.path]) toggle(row.folder.path, true); else if (rows[index + 1]?.parent === row.key) focus(rows[index + 1].key); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); if (row.folder && expanded[row.folder.path]) toggle(row.folder.path, false); else if (row.parent) focus(row.parent); }
    else if (event.key === "Enter") { event.preventDefault(); if (row.session) onConnect(row.session); else if (row.folder) toggle(row.folder.path); }
    else if (event.key === "Delete" && row.session) { event.preventDefault(); setDeleting(row.session); }
  };
  return <div className="sessions-panel">
    <div className="sessions-toolbar" aria-label="Sitzungsaktionen">
      <button title="Neue Sitzung" aria-label="Neue Sitzung" onClick={() => onEdit()}><Icon name="file-new" /></button>
      <button title="Bearbeiten" aria-label="Bearbeiten" disabled={!current} onClick={() => onEdit(current)}><Icon name="edit" /></button>
      <button title="Löschen" aria-label="Löschen" disabled={!current} onClick={() => current && setDeleting(current)}><Icon name="delete" /></button>
      <button title="Importieren" aria-expanded={importMenu} onClick={() => setImportMenu(!importMenu)}>Importieren</button>
      <button title="Aktualisieren" aria-label="Aktualisieren" onClick={onReload}><Icon name="refresh" /></button>
    </div>
    {importMenu && <div className="sessions-import-menu"><button title="Aus MobaXterm importieren" onClick={() => { setImportMenu(false); setImportSource("mobaxterm"); }}>Aus MobaXterm…</button><button title="Aus WindTerm importieren" onClick={() => { setImportMenu(false); setImportSource("windterm"); }}>Aus WindTerm…</button></div>}
    <input className="sessions-search" aria-label="Sitzungen suchen" placeholder="Sitzungen suchen…" value={query} onChange={event => setQuery(event.target.value)} />
    <div className="sessions-list" role="tree" aria-label="Gespeicherte Sitzungen">
      {rows.map((row, index) => <div key={row.key} ref={element => { if (element) rowRefs.current.set(row.key, element); else rowRefs.current.delete(row.key); }} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.folder ? Boolean(query || expanded[row.folder.path]) : undefined} aria-selected={selected === row.key} tabIndex={selected === row.key || (!rows.some(item => item.key === selected) && index === 0) ? 0 : -1} className="session-row" style={{ paddingLeft: 8 + row.depth * 14 }} onFocus={() => setSelected(row.key)} onClick={() => { setSelected(row.key); if (row.folder) toggle(row.folder.path); }} onDoubleClick={() => row.session && onConnect(row.session)} onKeyDown={event => keyDown(event, row, index)} onContextMenu={event => { if (!row.session) return; event.preventDefault(); setSelected(row.key); setContext({ x: event.clientX, y: event.clientY, session: row.session }); }}>
        <span aria-hidden="true">{row.folder ? query || expanded[row.folder.path] ? "▾" : "▸" : ""}</span><Icon name={row.folder ? "folder" : "star"} /><span className="session-row-label">{row.folder?.name ?? row.session?.name}{row.session && <small>{sessionLabel(row.session)}</small>}</span>
      </div>)}
      {rows.length === 0 && <p className="empty-state">{query ? "Keine passenden Sitzungen." : "Noch keine gespeicherten Sitzungen."}</p>}
    </div>
    {context && <div ref={contextRef} className="session-context" role="menu" aria-label="Sitzungsaktionen" style={{ left: Math.min(context.x, window.innerWidth - 160), top: Math.min(context.y, window.innerHeight - 130) }} onKeyDown={event => { if (event.key === "Escape") { setContext(null); focus(`session:${context.session.id}`); } if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const buttons = Array.from(contextRef.current?.querySelectorAll("button") ?? []); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus(); } }}>
      <button role="menuitem" onClick={() => { onConnect(context.session); setContext(null); }}>Verbinden</button><button role="menuitem" onClick={() => { focus(`session:${context.session.id}`); onEdit(context.session); setContext(null); }}>Bearbeiten</button><button role="menuitem" onClick={() => { focus(`session:${context.session.id}`); setDeleting(context.session); setContext(null); }}>Löschen</button>
    </div>}
    {deleting && <FileActionDialog prompt={{ type: "delete", message: `Sitzung „${deleting.name}“ löschen?`, answer: accepted => { const session = deleting; setDeleting(null); if (accepted) void deleteSession(session.id).then(() => { onReload(); onStatus("Sitzung gelöscht"); }).catch(() => onStatus("Sitzung konnte nicht gelöscht werden.")); } }} />}
    {importSource && <ImportDialog source={importSource} onClose={() => setImportSource(null)} onImported={count => { setImportSource(null); onReload(); onStatus(`${count} Sitzungen importiert`); }} />}
  </div>;
}
