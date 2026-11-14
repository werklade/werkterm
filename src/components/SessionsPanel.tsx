import { keyringErrorText } from "../lib/keyringErrors";
import { tp, useT } from "../i18n";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { buildSessionTree, collectFolderSessions, deleteSessions, selectSessions, jumpHostHint, searchSessions, sessionLabel, type SavedSession, type SessionFolder } from "../lib/sessions";
import { KindIcon } from "./KindIcon";
import { Icon } from "./Icon";
import { FileActionDialog } from "./FileActionDialog";
import { chooseSessionExport } from "../lib/sessionExport";
import { WerktermImportDialog } from "./WerktermImportDialog";
import { ImportDialog } from "./ImportDialog";
import "./SessionsPanel.css";

interface Props {
  sessions: SavedSession[];
  onConnect: (session: SavedSession) => void;
  onEdit: (session?: SavedSession) => void;
  onReload: () => void;
  onStatus: (message: string) => void;
  /** Called with the ids that were really deleted (after a successful delete). */
  onDeleted?: (ids: string[]) => void;
}
type Row = { key: string; depth: number; folder?: SessionFolder; session?: SavedSession; parent?: string };
function loadExpanded(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem("werkterm.sessionFolders") ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch { /* Storage may be unavailable. */ }
  return {};
}
export function SessionsPanel({ sessions, onConnect, onEdit, onReload, onStatus, onDeleted }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(loadExpanded);
  const [selected, setSelected] = useState("");
  const [selection, setSelection] = useState({ ids: [] as string[], anchor: "" });
  const [deleting, setDeleting] = useState<SavedSession[] | null>(null);
  const [importSource, setImportSource] = useState<"mobaxterm" | "windterm" | "werkterm" | null>(null);
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
    <div className="sessions-toolbar" aria-label={t("sessions.actions")}>
      {selectedSessions.length >= 2 && <span aria-live="polite">{t("sessions.selected", { count: selectedSessions.length })}</span>}
      <button title={t("sessions.new")} aria-label={t("sessions.new")} onClick={() => onEdit()}><Icon name="file-new" /></button>
      <button title={t("sessions.edit")} aria-label={t("sessions.edit")} disabled={!current} onClick={() => onEdit(current)}><Icon name="edit" /></button>
      <button title={t("common.delete")} aria-label={t("common.delete")} disabled={!selectedSessions.length} onClick={() => setDeleting(selectedSessions)}><Icon name="delete" /></button>
      <button title={selectedSessions.length ? tp("sessions.exportSelected", selectedSessions.length) : t("sessions.exportAll")} aria-label={t("sessions.export")} onClick={() => void chooseSessionExport(selectedSessions.map(session => session.id), onStatus)}><Icon name="download" /></button>
      <button title={t("sessions.import")} aria-label={t("sessions.import")} aria-expanded={importMenu} onClick={() => setImportMenu(!importMenu)}><Icon name="upload" /></button>
      <button title={t("sessions.refresh")} aria-label={t("sessions.refresh")} onClick={onReload}><Icon name="refresh" /></button>
    </div>
    {importMenu && <div className="sessions-import-menu"><button title={t("sessions.import.werktermTitle")} onClick={() => { setImportMenu(false); setImportSource("werkterm"); }}>{t("sessions.import.werkterm")}</button><button title={t("sessions.import.mobaxtermTitle")} onClick={() => { setImportMenu(false); setImportSource("mobaxterm"); }}>{t("sessions.import.mobaxterm")}</button><button title={t("sessions.import.windtermTitle")} onClick={() => { setImportMenu(false); setImportSource("windterm"); }}>{t("sessions.import.windterm")}</button></div>}
    <input className="sessions-search" aria-label={t("sessions.search")} placeholder={t("sessions.search.placeholder")} value={query} onChange={event => setQuery(event.target.value)} />
    <div className="sessions-list" role="tree" aria-multiselectable="true" aria-label={t("sessions.list")}>
      {rows.map((row, index) => <div key={row.key} ref={element => { if (element) rowRefs.current.set(row.key, element); else rowRefs.current.delete(row.key); }} title={row.session ? jumpHostHint(row.session, sessions) || undefined : undefined} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.folder ? Boolean(query || expanded[row.folder.path]) : undefined} aria-selected={row.session ? selectedSessions.some(session => session.id === row.session?.id) : selected === row.key} tabIndex={selected === row.key || (!rows.some(item => item.key === selected) && index === 0) ? 0 : -1} className="session-row" style={{ paddingLeft: 8 + row.depth * 14 }} onPointerDown={() => { preserveSelectionOnFocus.current = true; }} onPointerUp={() => { preserveSelectionOnFocus.current = false; }} onFocus={() => { setSelected(row.key); if (!preserveSelectionOnFocus.current && (selected !== row.key || selection.ids.length === 0)) choose(row); }} onClick={event => { choose(row, event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "single"); if (row.folder) toggle(row.folder.path); }} onDoubleClick={() => row.session && onConnect(row.session)} onKeyDown={event => keyDown(event, row, index)} onContextMenu={event => { event.preventDefault(); setSelected(row.key); if (row.session && !selectedSessions.some(session => session.id === row.session?.id)) choose(row); setContext({ x: event.clientX, y: event.clientY, row }); }}>
        <span aria-hidden="true">{row.folder ? query || expanded[row.folder.path] ? "▾" : "▸" : ""}</span>{row.folder ? <Icon name="folder" /> : <KindIcon kind={row.session?.kind ?? "ssh"} />}<span className="session-row-label">{row.folder?.name ?? row.session?.name}{row.session && <small title={[sessionLabel(row.session), jumpHostHint(row.session, sessions)].filter(Boolean).join(" – ")}>{sessionLabel(row.session)}{row.session.jumpSessionId && <> · <span className="jump-inline"><Icon name="jump" /></span> {jumpHostHint(row.session, sessions)}</>}</small>}</span>
      </div>)}
      {rows.length === 0 && <p className="empty-state">{query ? t("sessions.empty.search") : t("sessions.empty")}</p>}
    </div>
    {context && <div ref={contextRef} className="session-context" role="menu" aria-label={t("sessions.actions")} style={{ left: Math.min(context.x, window.innerWidth - 160), top: Math.min(context.y, Math.max(0, window.innerHeight - 170)) }} onKeyDown={event => { if (event.key === "Escape") { setContext(null); preserveSelectionOnFocus.current = true; rowRefs.current.get(context.row.key)?.focus(); preserveSelectionOnFocus.current = false; } if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const buttons = Array.from(contextRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus(); } }}>
      {context.row.session && <><button role="menuitem" onClick={() => { onConnect(context.row.session!); setContext(null); }}>{t("sessions.connect")}</button><button role="menuitem" disabled={selectedSessions.length !== 1} onClick={() => { onEdit(context.row.session); setContext(null); }}>{t("sessions.edit")}</button></>}
      <button role="menuitem" onClick={() => {
        const targets = context.row.folder ? folderSessions(context.row.folder) : selectedSessions;
        setContext(null);
        if (targets.length) void chooseSessionExport(targets.map(session => session.id), onStatus);
      }}>{context.row.folder ? t("sessions.exportFolder") : tp("sessions.exportCount", Math.max(1, selectedSessions.length))}</button>
      <button role="menuitem" onClick={() => {
        setDeleting(context.row.folder ? folderSessions(context.row.folder) : selectedSessions);
        setContext(null);
      }}>{context.row.folder ? t("sessions.deleteFolder") : tp("sessions.deleteCount", Math.max(1, selectedSessions.length))}</button>
    </div>}
    {deleting && <FileActionDialog prompt={{ type: "delete", message: `${tp("sessions.deleteConfirm", deleting.length)}\n${deleting.slice(0, 10).map(session => session.name).join("\n")}${deleting.length > 10 ? `\n${t("sessions.deleteMore", { count: deleting.length - 10 })}` : ""}\n${t("sessions.deleteKeyring")}`, answer: accepted => {
      const targets = deleting; setDeleting(null);
      if (accepted) void deleteSessions(targets.map(session => session.id)).then(result => {
        onReload();
        if (result.deleted.length) onDeleted?.(result.deleted);
        setSelection(previous => ({ ...previous, ids: previous.ids.filter(id => !result.deleted.includes(id)) }));
        onStatus([result.blocked.length ? t("sessions.deletedBlocked", { deleted: result.deleted.length, blocked: result.blocked.length, items: result.blocked.map(item => `${item.name} (${item.reason})`).join(", ") }) : tp("sessions.deleted", result.deleted.length), ...result.warnings.map(keyringErrorText)].join("; "));
      }).catch(reason => { onReload(); onStatus(keyringErrorText(reason)); });
    } }} />}
    {importSource === "werkterm" && <WerktermImportDialog onClose={() => setImportSource(null)} onImported={result => { setImportSource(null); onReload(); onStatus([tp("sessions.imported", result.imported, { skipped: result.skippedDuplicates }), ...(result.warnings ?? [])].join("; ")); }} />}
    {importSource && importSource !== "werkterm" && <ImportDialog source={importSource} onClose={() => setImportSource(null)} onImported={result => { setImportSource(null); onReload(); onStatus([tp("sessions.imported", result.imported, { skipped: result.skippedDuplicates }), ...(result.warnings ?? [])].join("; ")); }} />}
  </div>;
}
