import { keyringErrorText } from "../lib/keyringErrors";
import { tp, useT } from "../i18n";
import { errorText } from "../lib/backendError";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  allFolderPaths, buildSessionTree, collectFolderSessions, createSessionFolder, deleteSessionFolder, deleteSessions, folderName, isWithinFolder, joinFolder,
  jumpHostHint, moveAllowed, movedFolderPath, moveSessions, normalizeFolder, parentFolder, removeSessionFolder, renameSessionFolder,
  restoreSessionLayout, searchSessions, selectSessions, sessionLabel, trimFolderSegment, validFolderName,
  type LayoutChange, type MoveItem, type SavedSession, type SessionFolder,
} from "../lib/sessions";
import { dropTargetAt, passedThreshold } from "../lib/sessionDrag";
import { KindIcon } from "./KindIcon";
import { Icon } from "./Icon";
import { FileActionDialog } from "./FileActionDialog";
import { SessionFolderNameDialog, SessionMoveDialog } from "./SessionFolderDialogs";
import { chooseSessionExport } from "../lib/sessionExport";
import { WerktermImportDialog } from "./WerktermImportDialog";
import { ImportDialog } from "./ImportDialog";
import "./SessionsPanel.css";

interface Props {
  sessions: SavedSession[];
  /** Empty folders (paths without a session). */
  folders?: string[];
  onConnect: (session: SavedSession) => void;
  onEdit: (session?: SavedSession) => void;
  onReload: () => void;
  onStatus: (message: string) => void;
  /** Called with the ids that were really deleted (after a successful delete). */
  onDeleted?: (ids: string[]) => void;
  /** After an own write of sessions.json (move, rename, folders): reload and take the file as the new baseline. */
  onWritten?: () => void;
  /** Shows `message` in the status line with an "Undo" action for a short time. */
  onUndoable?: (message: string, undo: () => void) => void;
}
type Row = { key: string; depth: number; folder?: SessionFolder; session?: SavedSession; parent?: string };
type DragState = { item: MoveItem; target: string | null };
type PendingDrag = { pointerId: number; x: number; y: number; item: MoveItem; active: boolean };
function loadExpanded(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem("werkterm.sessionFolders") ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch { /* Storage may be unavailable. */ }
  return {};
}
/** Expanded state follows a renamed or moved folder. */
function renameExpanded(expanded: Record<string, boolean>, from: string, to: string): Record<string, boolean> {
  return Object.fromEntries(Object.entries(expanded).map(([path, open]) => [isWithinFolder(path, from) ? `${to}${path.slice(from.length)}` : path, open]));
}
export function SessionsPanel({ sessions, folders = [], onConnect, onEdit, onReload, onStatus, onDeleted, onWritten, onUndoable }: Props) {
  const t = useT();
  // Hook order matters for SessionsPanel.test.tsx (state 7 is the context menu); new state goes after it.
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(loadExpanded);
  const [selected, setSelected] = useState("");
  const [selection, setSelection] = useState({ ids: [] as string[], anchor: "" });
  const [deleting, setDeleting] = useState<SavedSession[] | null>(null);
  const [importSource, setImportSource] = useState<"mobaxterm" | "windterm" | "werkterm" | null>(null);
  const [importMenu, setImportMenu] = useState(false);
  const [context, setContext] = useState<{ x: number; y: number; row: Row } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [moving, setMoving] = useState<MoveItem | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [merging, setMerging] = useState<{ path: string; to: string; name: string } | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const preserveSelectionOnFocus = useRef(false);
  const pending = useRef<PendingDrag | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const cancelled = useRef(false);
  const renameActive = useRef(false);
  const deletingFolder = useRef<string | null>(null);
  useEffect(() => { try { localStorage.setItem("werkterm.sessionFolders", JSON.stringify(expanded)); } catch { /* Storage may be unavailable. */ } }, [expanded]);
  useEffect(() => {
    if (!context) return;
    contextRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => { if (!contextRef.current?.contains(event.target as Node)) setContext(null); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [context]);
  // Escape cancels a running drag wherever the focus is. The captured pointer is released on the next pointerup, and
  // exactly the next click is swallowed (see pointerUp).
  useEffect(() => {
    if (!drag) return;
    const cancel = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelDrag(); } };
    document.addEventListener("keydown", cancel, true);
    return () => document.removeEventListener("keydown", cancel, true);
  }, [drag]);
  // A press below the threshold never stays pending: released anywhere in the window, or the window lost the focus.
  useEffect(() => {
    const release = () => { if (pending.current && !pending.current.active) pending.current = null; };
    const blur = () => { if (pending.current?.active) cancelDrag(); else pending.current = null; };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("pointerup", release, true); window.removeEventListener("blur", blur); };
  }, []);
  const rows: Row[] = [];
  const append = (folder: SessionFolder, depth: number, parent?: string) => {
    for (const child of folder.folders) {
      const key = `folder:${child.path}`;
      rows.push({ key, depth, folder: child, parent });
      if (query || expanded[child.path]) append(child, depth + 1, key);
    }
    for (const session of folder.sessions) rows.push({ key: `session:${session.id}`, depth, session, parent });
  };
  // Empty folders only without a search: a search shows matching sessions.
  append(buildSessionTree(searchSessions(sessions, query), query ? [] : folders), 0);
  const visibleIds = rows.flatMap(row => row.session ? [row.session.id] : []);
  const selectedSessions = sessions.filter(session => selection.ids.includes(session.id) && visibleIds.includes(session.id));
  const current = selectedSessions.length === 1 ? selectedSessions[0] : undefined;
  const choose = (row: Row, action: "single" | "toggle" | "range" = "single") => {
    setSelected(row.key);
    setSelection(previous => selectSessions(previous, visibleIds, row.session?.id ?? "", action));
  };
  const fullFolder = (path: string) => {
    const find = (node: SessionFolder): SessionFolder | undefined => node.path === path ? node : node.folders.map(find).find(Boolean);
    return find(buildSessionTree(sessions, folders));
  };
  const folderSessions = (folder: SessionFolder) => {
    const full = fullFolder(folder.path);
    return full ? collectFolderSessions(full) : [];
  };
  const toggle = (path: string, value?: boolean) => setExpanded(previous => ({ ...previous, [path]: value ?? !previous[path] }));
  /** Opens `path` and all its parents, so moved sessions stay visible. */
  const reveal = (path: string) => setExpanded(previous => {
    const next = { ...previous };
    const parts = normalizeFolder(path).split("/").filter(Boolean);
    for (let index = 1; index <= parts.length; index++) next[parts.slice(0, index).join("/")] = true;
    return next;
  });
  const focusRow = (key: string) => { preserveSelectionOnFocus.current = true; rowRefs.current.get(key)?.focus(); preserveSelectionOnFocus.current = false; };
  /** After a dialog: the element that had the focus (menu entry) is gone, so the row gets it back. */
  const refocus = (key: string) => { window.setTimeout(() => focusRow(key), 0); };
  const focus = (key: string, extend = false) => { const row = rows.find(item => item.key === key); if (row) choose(row, extend ? "range" : "single"); focusRow(key); };
  const written = () => (onWritten ?? onReload)();
  const folderLabel = (path: string) => path || t("sessions.root");
  /** Undo of a folder rename/move also brings back the expanded state of both subtrees as it was before. */
  const expandedRestorer = (from: string, to: string) => {
    const snapshot = expanded;
    const inside = (path: string) => isWithinFolder(path, from) || isWithinFolder(path, to);
    return () => setExpanded(previous => ({
      ...Object.fromEntries(Object.entries(previous).filter(([path]) => !inside(path))),
      ...Object.fromEntries(Object.entries(snapshot).filter(([path]) => inside(path))),
    }));
  };
  const offerUndo = (message: string, change: LayoutChange, afterUndo?: () => void) => {
    const undo = () => void restoreSessionLayout(change.undo)
      .then(result => {
        written();
        afterUndo?.();
        onStatus(result.skipped > 0 ? tp("sessions.undonePartly", result.skipped) : t("sessions.undone"));
      })
      .catch(reason => { written(); onStatus(errorText(reason)); });
    if (onUndoable) onUndoable(message, undo); else onStatus(message);
  };
  const renameFolder = (path: string, to: string, message: string, select: boolean) => {
    const restoreExpanded = expandedRestorer(path, to);
    void renameSessionFolder(path, to).then(change => {
      written();
      if (!change.changed) return;
      setExpanded(previous => renameExpanded(previous, path, to));
      if (select) { setSelected(`folder:${to}`); refocus(`folder:${to}`); }
      offerUndo(message, change, restoreExpanded);
    }).catch(reason => { written(); onStatus(errorText(reason)); });
  };
  const moveItem = (item: MoveItem, target: string) => {
    if (!moveAllowed(item, target, sessions)) return;
    if (item.kind === "folder") {
      // Dragging merges into an existing folder without asking (undo is offered).
      reveal(target);
      renameFolder(item.path, movedFolderPath(item.path, target), t("sessions.folderMoved", { name: folderName(item.path), folder: folderLabel(target) }), false);
      return;
    }
    void moveSessions(item.ids, target).then(change => {
      written();
      if (!change.changed) return;
      reveal(target);
      offerUndo(tp("sessions.moved", change.moved, { folder: folderLabel(target) }), change);
    }).catch(reason => { written(); onStatus(errorText(reason)); });
  };
  const rowItem = (row: Row): MoveItem | null => row.folder ? { kind: "folder", path: row.folder.path }
    : row.session ? { kind: "sessions", ids: selectedSessions.some(session => session.id === row.session?.id) ? selectedSessions.map(session => session.id) : [row.session.id] } : null;
  const startRename = (folder: SessionFolder) => { renameActive.current = true; setRenaming({ path: folder.path, value: folder.name }); };
  const finishRename = (commit: boolean) => {
    if (!renameActive.current || !renaming) return;
    renameActive.current = false;
    const { path, value } = renaming;
    setRenaming(null);
    refocus(`folder:${path}`);
    const name = trimFolderSegment(value);
    if (!commit || name === folderName(path)) return;
    if (!validFolderName(name)) { onStatus(t("sessions.folderNameInvalid")); return; }
    const to = joinFolder(parentFolder(path), name);
    // Renaming onto an existing sibling would merge both folders: ask first.
    if (allFolderPaths(sessions, folders).includes(to)) { setMerging({ path, to, name }); return; }
    renameFolder(path, to, t("sessions.folderRenamed", { name: folderName(path), to: name }), true);
  };
  const clearDrag = () => { pending.current = null; dragRef.current = null; setDrag(null); };
  /** Escape, window blur, pointer cancel: the next pointerup releases the capture and the next click is swallowed. */
  const cancelDrag = () => { if (pending.current?.active) cancelled.current = true; clearDrag(); };
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>, row: Row) => {
    preserveSelectionOnFocus.current = true;
    // A new press starts clean: stale flags from a drag whose pointerup/click went elsewhere must not eat it.
    suppressClick.current = false;
    cancelled.current = false;
    if (event.button !== 0 || renaming) return;
    const item = rowItem(row);
    pending.current = item ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, item, active: false } : null;
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = pending.current;
    if (!press || press.pointerId !== event.pointerId) return;
    // Primary button no longer held (pointerup went elsewhere): end instead of hanging.
    if ((event.buttons & 1) === 0) { if (press.active) cancelDrag(); else pending.current = null; return; }
    if (!press.active) {
      if (!passedThreshold(press, event.clientX, event.clientY)) return;
      press.active = true;
      setContext(null);
      // Capture keeps the events on this row while the pointer is over other rows or outside the window.
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer already released. */ }
    }
    const found = dropTargetAt(document.elementFromPoint(event.clientX, event.clientY));
    const target = found !== null && moveAllowed(press.item, found, sessions) ? found : null;
    if (dragRef.current?.target !== target || !dragRef.current) { dragRef.current = { item: press.item, target }; setDrag(dragRef.current); }
  };
  const releaseCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    try { if (event.currentTarget.hasPointerCapture?.(event.pointerId) ?? true) event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    preserveSelectionOnFocus.current = false;
    if (cancelled.current) {
      cancelled.current = false;
      suppressClick.current = true;
      releaseCapture(event);
      pending.current = null;
      return;
    }
    const press = pending.current;
    if (!press || press.pointerId !== event.pointerId) return;
    const target = press.active ? dragRef.current?.target ?? null : null;
    const item = press.item;
    if (press.active) { releaseCapture(event); suppressClick.current = true; }
    clearDrag();
    if (target !== null) moveItem(item, target);
  };
  const openContext = (row: Row, x: number, y: number) => {
    setSelected(row.key);
    if (row.session && !selectedSessions.some(session => session.id === row.session?.id)) choose(row);
    setContext({ x, y, row });
  };
  const keyDown = (event: KeyboardEvent, row: Row, index: number) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      focus(rows[next].key, event.shiftKey);
    } else if (event.key === "ArrowRight" && row.folder) { event.preventDefault(); if (!expanded[row.folder.path]) toggle(row.folder.path, true); else if (rows[index + 1]?.parent === row.key) focus(rows[index + 1].key); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); if (row.folder && expanded[row.folder.path]) toggle(row.folder.path, false); else if (row.parent) focus(row.parent); }
    else if (event.key === "Enter") { event.preventDefault(); if (row.session) onConnect(row.session); else if (row.folder) toggle(row.folder.path); }
    else if (event.key === "F2" && row.folder) { event.preventDefault(); startRename(row.folder); }
    else if (event.key === "F10" && event.shiftKey) {
      event.preventDefault();
      const rect = rowRefs.current.get(row.key)?.getBoundingClientRect();
      openContext(row, rect ? rect.left + 24 : 0, rect ? rect.bottom : 0);
    }
    else if (event.key === "Delete" && selectedSessions.length > 0) { event.preventDefault(); setDeleting(selectedSessions); }
  };
  const selectedRow = rows.find(row => row.key === selected);
  /** "New folder" from the toolbar: inside the selected folder, or next to the selected session. */
  const selectedFolder = selectedRow?.folder?.path ?? normalizeFolder(selectedRow?.session?.folder ?? "");
  const dropRoot = drag?.target === "";
  const dragged = (row: Row) => drag !== null && (drag.item.kind === "folder" ? row.folder?.path === drag.item.path : !!row.session && drag.item.ids.includes(row.session.id));
  const contextFolder = context?.row.folder;
  const contextFolderEmpty = contextFolder ? folderSessions(contextFolder).length === 0 : false;
  const movingTitle = moving ? moving.kind === "folder" ? t("sessions.moveDialog.folderTitle", { name: folderName(moving.path) }) : tp("sessions.moveDialog.title", moving.ids.length) : "";
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
      <button title={t("sessions.newFolder")} aria-label={t("sessions.newFolder")} onClick={() => setCreating(selectedFolder)}><Icon name="folder-new" /></button>
      <button title={t("sessions.edit")} aria-label={t("sessions.edit")} disabled={!current} onClick={() => onEdit(current)}><Icon name="edit" /></button>
      <button title={t("common.delete")} aria-label={t("common.delete")} disabled={!selectedSessions.length} onClick={() => setDeleting(selectedSessions)}><Icon name="delete" /></button>
      <button title={selectedSessions.length ? tp("sessions.exportSelected", selectedSessions.length) : t("sessions.exportAll")} aria-label={t("sessions.export")} onClick={() => void chooseSessionExport(selectedSessions.map(session => session.id), onStatus)}><Icon name="download" /></button>
      <button title={t("sessions.import")} aria-label={t("sessions.import")} aria-expanded={importMenu} onClick={() => setImportMenu(!importMenu)}><Icon name="upload" /></button>
      <button title={t("sessions.refresh")} aria-label={t("sessions.refresh")} onClick={onReload}><Icon name="refresh" /></button>
    </div>
    {importMenu && <div className="sessions-import-menu"><button title={t("sessions.import.werktermTitle")} onClick={() => { setImportMenu(false); setImportSource("werkterm"); }}>{t("sessions.import.werkterm")}</button><button title={t("sessions.import.mobaxtermTitle")} onClick={() => { setImportMenu(false); setImportSource("mobaxterm"); }}>{t("sessions.import.mobaxterm")}</button><button title={t("sessions.import.windtermTitle")} onClick={() => { setImportMenu(false); setImportSource("windterm"); }}>{t("sessions.import.windterm")}</button></div>}
    <input className="sessions-search" aria-label={t("sessions.search")} placeholder={t("sessions.search.placeholder")} value={query} onChange={event => setQuery(event.target.value)} />
    <div className={`sessions-list${dropRoot ? " drop-target" : ""}${drag ? " dragging" : ""}`} role="tree" aria-multiselectable="true" aria-label={t("sessions.list")} aria-describedby="sessions-drag-hint">
      {rows.map((row, index) => {
        const dropFolder = row.folder ? row.folder.path : normalizeFolder(row.session?.folder ?? "");
        const isTarget = !!row.folder && drag?.target === row.folder.path;
        const editing = !!row.folder && renaming?.path === row.folder.path;
        return <div key={row.key} ref={element => { if (element) rowRefs.current.set(row.key, element); else rowRefs.current.delete(row.key); }} title={row.session ? jumpHostHint(row.session, sessions) || undefined : undefined} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.folder ? Boolean(query || expanded[row.folder.path]) : undefined} aria-selected={row.session ? selectedSessions.some(session => session.id === row.session?.id) : selected === row.key} tabIndex={selected === row.key || (!rows.some(item => item.key === selected) && index === 0) ? 0 : -1} className={`session-row${isTarget ? " drop-target" : ""}${dragged(row) ? " drag-source" : ""}`} data-drop-folder={dropFolder} style={{ paddingLeft: 8 + row.depth * 14 }}
          onPointerDown={event => pointerDown(event, row)} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelDrag} onLostPointerCapture={() => { if (pending.current?.active) cancelDrag(); }}
          onFocus={() => { setSelected(row.key); if (!preserveSelectionOnFocus.current && (selected !== row.key || selection.ids.length === 0)) choose(row); }}
          onClick={event => { if (suppressClick.current) { suppressClick.current = false; return; } if (editing) return; choose(row, event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "single"); if (row.folder) toggle(row.folder.path); }}
          onDoubleClick={() => row.session && onConnect(row.session)} onKeyDown={event => keyDown(event, row, index)}
          onContextMenu={event => {
            event.preventDefault();
            // Context-menu key: no pointer position, so the menu opens below the row.
            const rect = event.clientX === 0 && event.clientY === 0 ? event.currentTarget.getBoundingClientRect() : null;
            openContext(row, rect ? rect.left + 24 : event.clientX, rect ? rect.bottom : event.clientY);
          }}>
          <span aria-hidden="true">{row.folder ? query || expanded[row.folder.path] ? "▾" : "▸" : ""}</span>{row.folder ? <Icon name="folder" /> : <KindIcon kind={row.session?.kind ?? "ssh"} />}
          {editing ? <input className="session-rename" autoFocus aria-label={t("sessions.folderName")} value={renaming.value} aria-invalid={!validFolderName(renaming.value)}
            onChange={event => setRenaming({ path: renaming.path, value: event.target.value })}
            onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") { event.preventDefault(); finishRename(true); } else if (event.key === "Escape") { event.preventDefault(); finishRename(false); } }}
            onBlur={() => finishRename(true)} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onFocus={event => { event.stopPropagation(); event.currentTarget.select(); }} />
            : <span className="session-row-label">{row.folder?.name ?? row.session?.name}{row.session && <small title={[sessionLabel(row.session), jumpHostHint(row.session, sessions)].filter(Boolean).join(" – ")}>{sessionLabel(row.session)}{row.session.jumpSessionId && <> · <span className="jump-inline"><Icon name="jump" /></span> {jumpHostHint(row.session, sessions)}</>}</small>}</span>}
        </div>;
      })}
      {rows.length === 0 && <p className="empty-state">{query ? t("sessions.empty.search") : t("sessions.empty")}</p>}
    </div>
    <p id="sessions-drag-hint" className="sessions-visually-hidden">{t("sessions.dragHint")}</p>
    {context && <div ref={contextRef} className="session-context" role="menu" aria-label={t("sessions.actions")} style={{ left: Math.min(context.x, window.innerWidth - 200), top: Math.min(context.y, Math.max(0, window.innerHeight - 280)) }} onKeyDown={event => { if (event.key === "Escape") { setContext(null); focusRow(context.row.key); } if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const buttons = Array.from(contextRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus(); } }}>
      {context.row.session && <><button role="menuitem" onClick={() => { onConnect(context.row.session!); setContext(null); }}>{t("sessions.connect")}</button><button role="menuitem" disabled={selectedSessions.length !== 1} onClick={() => { onEdit(context.row.session); setContext(null); }}>{t("sessions.edit")}</button></>}
      <button role="menuitem" onClick={() => { const item = rowItem(context.row); setContext(null); setMoving(item); }}>{t("sessions.moveTo")}</button>
      {contextFolder && <>
        <button role="menuitem" aria-keyshortcuts="F2" onClick={() => { setContext(null); startRename(contextFolder); }}>{t("sessions.renameFolder")}</button>
        <button role="menuitem" onClick={() => { setContext(null); setCreating(contextFolder.path); }}>{t("sessions.newFolder")}</button>
      </>}
      {!contextFolderEmpty && <button role="menuitem" onClick={() => {
        const targets = contextFolder ? folderSessions(contextFolder) : selectedSessions;
        setContext(null);
        if (targets.length) void chooseSessionExport(targets.map(session => session.id), onStatus);
      }}>{contextFolder ? t("sessions.exportFolder") : tp("sessions.exportCount", Math.max(1, selectedSessions.length))}</button>}
      {contextFolder && contextFolderEmpty
        ? <button role="menuitem" onClick={() => {
          const path = contextFolder.path;
          setContext(null);
          void removeSessionFolder(path).then(() => { written(); onStatus(t("sessions.folderRemoved", { folder: path })); refocus(parentFolder(path) ? `folder:${parentFolder(path)}` : rows[0]?.key ?? ""); })
            .catch(reason => { written(); onStatus(errorText(reason)); });
        }}>{t("sessions.removeFolder")}</button>
        : <button role="menuitem" onClick={() => {
          deletingFolder.current = contextFolder?.path ?? null;
          setDeleting(contextFolder ? folderSessions(contextFolder) : selectedSessions);
          setContext(null);
        }}>{contextFolder ? t("sessions.deleteFolder") : tp("sessions.deleteCount", Math.max(1, selectedSessions.length))}</button>}
    </div>}
    {deleting && <FileActionDialog prompt={{ type: "delete", message: `${tp("sessions.deleteConfirm", deleting.length)}\n${deleting.slice(0, 10).map(session => session.name).join("\n")}${deleting.length > 10 ? `\n${t("sessions.deleteMore", { count: deleting.length - 10 })}` : ""}\n${t("sessions.deleteKeyring")}`, answer: accepted => {
      const targets = deleting; setDeleting(null);
      const folder = deletingFolder.current; deletingFolder.current = null;
      // A folder goes in one backend write together with its empty subfolders.
      if (accepted) void (folder ? deleteSessionFolder(folder) : deleteSessions(targets.map(session => session.id))).then(result => {
        if (folder) written(); else onReload();
        if (result.deleted.length) onDeleted?.(result.deleted);
        setSelection(previous => ({ ...previous, ids: previous.ids.filter(id => !result.deleted.includes(id)) }));
        onStatus([result.blocked.length ? t("sessions.deletedBlocked", { deleted: result.deleted.length, blocked: result.blocked.length, items: result.blocked.map(item => `${item.name} (${errorText(item.reason)})`).join(", ") }) : tp("sessions.deleted", result.deleted.length), ...result.warnings.map(keyringErrorText)].join("; "));
      }).catch(reason => { onReload(); onStatus(keyringErrorText(reason)); });
    } }} />}
    {moving && <SessionMoveDialog title={movingTitle} folders={allFolderPaths(sessions, folders).filter(path => moving.kind !== "folder" || !isWithinFolder(path, moving.path))} allowed={target => moveAllowed(moving, target, sessions)} onAnswer={target => {
      const item = moving; setMoving(null);
      refocus(selected);
      if (target !== null) moveItem(item, target);
    }} />}
    {merging && <FileActionDialog prompt={{ type: "delete", message: t("sessions.mergeConfirm", { name: merging.name }), confirmLabel: t("sessions.mergeConfirm.confirm"), answer: accepted => {
      const { path, to, name } = merging; setMerging(null);
      refocus(`folder:${path}`);
      if (accepted) renameFolder(path, to, t("sessions.folderRenamed", { name: folderName(path), to: name }), true);
    } }} />}
    {creating !== null && <SessionFolderNameDialog title={t("sessions.newFolder.title", { folder: folderLabel(creating) })} onAnswer={name => {
      const parent = creating; setCreating(null);
      refocus(selected);
      if (name === null) return;
      const path = joinFolder(parent, name);
      void createSessionFolder(path).then(() => { written(); reveal(path); onStatus(t("sessions.folderCreated", { folder: path })); })
        .catch(reason => onStatus(errorText(reason)));
    }} />}
    {importSource === "werkterm" && <WerktermImportDialog onClose={() => setImportSource(null)} onImported={result => { setImportSource(null); onReload(); onStatus([tp("sessions.imported", result.imported, { skipped: result.skippedDuplicates }), ...(result.warnings ?? []).map(errorText)].join("; ")); }} />}
    {importSource && importSource !== "werkterm" && <ImportDialog source={importSource} onClose={() => setImportSource(null)} onImported={result => { setImportSource(null); onReload(); onStatus([tp("sessions.imported", result.imported, { skipped: result.skippedDuplicates }), ...(result.warnings ?? []).map(errorText)].join("; ")); }} />}
  </div>;
}
