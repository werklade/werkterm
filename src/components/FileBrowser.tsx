import type { DiffSource } from "../lib/diff";
import { errorCode } from "../lib/backendError";
import { useEffect, useRef, useState } from "react";
import { PermissionsDialog } from "./PermissionsDialog";
import { SecretDialog } from "./SecretDialog";
import { BrowserContextMenu, UploadMenu } from "./BrowserContextMenu";
import { changePermissions, countPermissionEntries, permissionRoute, disableSudo, enableSudo, modeToRwx, type ChmodOptions } from "../lib/permissions";
import { parseQuickConnect } from "../lib/quickConnect";
import { ResizeGrip } from "./ResizeGrip";
import { DEFAULT_COLUMNS, loadWidth, storeWidth, type ColumnWidths } from "../lib/browserWidths";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { dropToCss } from "../lib/dropPosition";
import { open, save } from "@tauri-apps/plugin-dialog";
import { sep } from "@tauri-apps/api/path";
import { Icon, type IconName } from "./Icon";
import { FileActionDialog, type FileDialog } from "./FileActionDialog";
import { InlineRename } from "./InlineRename";
import { renameOutcome } from "../lib/inlineRename";
import { listLocalDir, listSshDir, type DirEntry, type DirListing } from "../lib/fs";
import { childPath, parentPath } from "../lib/paths";
import { formatSize } from "../lib/formatSize";
import { loadFileSort, saveFileSort, sortFileEntries, type FileSortColumn } from "../lib/fileSort";
import type { Settings } from "../lib/settings";
import { countEntries, createFile, deleteEntry, makeDirectory, remoteChild, renameEntry } from "../lib/transfers";
import type { TransferQueueHandle } from "../lib/transferQueue";
import { backendErrorText } from "../lib/transferFormat";
import { currentLocale, tp, useT, type TextKey } from "../i18n";
import { collapseToFocus, EMPTY_SELECTION, focusOnly, isSelected, moveFocus, prune, selectAll, selectRange, selectSingle, toggle, type Selection } from "../lib/browserSelection";
import "./FileBrowser.css";

export interface BrowserTab {
  id: number;
  kind: "local" | "wsl" | "ssh" | "telnet" | "serial" | "editor" | "diff" | "folderDiff";
  title: string;
  /** Built-in titles: translated at render time from this key; `title` stays the plain-text fallback. */
  titleKey?: TextKey;
  titleParams?: Record<string, string | number>;
  serial?: import("../lib/sessions").SerialConfig | null;
  target?: string;
  savedSessionId?: string;
  startCommand?: import("../lib/pty").StartCommand;
  /** Shell profile id of local/WSL tabs (see `ShellProfile`); absent for the default shell. */
  profile?: string;
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
  | { type: "permissions"; entry: DirEntry; count?: number; anyDir?: boolean; answer: (options: ChmodOptions | null) => void };
type Action = "sudo" | "chmod" | "up" | "refresh" | "download" | "upload" | "uploadFolder" | "mkdir" | "create" | "delete" | "rename" | "edit";
// Module-level lists hold keys only; they are translated while rendering.
const actions: { icon: IconName; label: TextKey; action?: Action }[] = [
  { icon: "folder-up", label: "browser.action.up", action: "up" },
  { icon: "download", label: "browser.action.download", action: "download" },
  { icon: "upload", label: "browser.action.upload", action: "upload" },
  { icon: "refresh", label: "browser.action.refresh", action: "refresh" },
  { icon: "folder-new", label: "browser.action.mkdir", action: "mkdir" },
  { icon: "file-new", label: "browser.action.create", action: "create" },
  { icon: "delete", label: "common.delete", action: "delete" },
  { icon: "rename", label: "browser.action.rename", action: "rename" },
  { icon: "permissions", label: "browser.action.sudo", action: "sudo" }, { icon: "edit", label: "browser.action.edit", action: "edit" },
];
const settingLabels: { key: "followTerminalFolder" | "shellIntegration" | "sshPromptCommand"; label: TextKey; title: TextKey }[] = [
  { key: "followTerminalFolder", label: "browser.followTerminalFolder", title: "browser.followTerminalFolder.title" },
  { key: "shellIntegration", label: "browser.shellIntegration", title: "browser.shellIntegration.title" },
  { key: "sshPromptCommand", label: "browser.sshPromptCommand", title: "browser.sshPromptCommand.title" },
];
const isDirectory = (entry: DirEntry) => entry.kind === "dir" || (entry.kind === "symlink" && entry.targetIsDir);
/** How many names a multi-delete confirmation or error summary lists. */
const LISTED_NAMES = 3;
const listNames = (names: string[]) => names.slice(0, LISTED_NAMES).join(", ") + (names.length > LISTED_NAMES ? ", …" : "");
const single = (name: string): Selection => ({ names: [name], anchor: name, focus: name });

export function FileBrowser({ markedSource, onCompareFile, tab, settings, onSettings, onPath, onAccess, onStatus, onOpenFile, transferQueue }: Props) {
  const t = useT();
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
  /** Multi-selection (names in display order, Shift anchor, keyboard focus); pruned against the listing while rendering. */
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  /** Name of the entry whose name is being edited in place (F2, toolbar, context menu). */
  const [renaming, setRenaming] = useState<string | null>(null);
  // Mirrors `renaming` synchronously: a blur from an input removed by a reload must not rename.
  const renameTarget = useRef<string | null>(null);
  /** Entry to select after the next listing load (kept across the reload after a rename). */
  const pendingSelect = useRef<string | null>(null);
  /** Move the keyboard focus to the focused row (roving tabindex) once the list is shown again. */
  const focusSelected = useRef(false);
  /** Folder (tab, session and path) of the last load: another folder clears the selection, a reload keeps it. */
  const loadedFolder = useRef<string | null>(null);
  /** A mouse press focuses the row before the click; the click decides about the selection then. */
  const pointerFocus = useRef(false);
  /** Rename chosen in the context menu: starts once the menu has closed and given the focus back. */
  const renameAfterMenu = useRef<DirEntry | null>(null);
  const [context, setContext] = useState<{ entry: DirEntry; x: number; y: number; count?: number } | null>(null);
  const [uploadMenu, setUploadMenu] = useState<{ x: number; y: number } | null>(null);
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
    const folder = JSON.stringify([id, kind, sessionId, distro, path]);
    if (pendingSelect.current !== null) setSelection(single(pendingSelect.current));
    else if (loadedFolder.current !== folder) setSelection(EMPTY_SELECTION);
    loadedFolder.current = folder;
    pendingSelect.current = null;
    renameTarget.current = null;
    setRenaming(null);
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
      const message = t("browser.loadFailed", { reason: backendErrorText(reason) });
      setLoading(false);
      setError(message);
      callbacks.current.onStatus(message);
    });
    return () => { ++request.current; };
  }, [id, kind, path, sessionId, distro, ready, revision]);

  useEffect(() => {
    if (!focusSelected.current || renaming !== null || loading || !listing) return;
    focusSelected.current = false;
    listRef.current?.querySelector<HTMLTableRowElement>("tbody tr[tabindex='0']")?.focus();
  }, [renaming, loading, listing, selection]);

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
  const sortedEntries = listing ? sortFileEntries(listing.entries, sort) : [];
  const order = sortedEntries.map(entry => entry.name);
  // Reloads and a new sort order drop vanished names and restore the display order.
  const current = prune(selection, order);
  const selectedEntries = sortedEntries.filter(entry => isSelected(current, entry.name));
  const selectedEntry = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
  const multiple = selectedEntries.length > 1;
  const focusName = current.focus !== null && order.includes(current.focus) ? current.focus : order[0];
  /** Entries an action applies to: the selection, or only the context entry if it is not part of it. */
  const targetsFor = (contextEntry?: DirEntry) => contextEntry && !isSelected(current, contextEntry.name) ? [contextEntry] : selectedEntries;
  const editorReady = ready && !loading && (kind !== "ssh" || listing?.mode === "sftp");
  const openEntry = (entry: DirEntry) => {
    if (tab && listing && editorReady && !isDirectory(entry)) onOpenFile(tab, childPath(listing.path, entry.name));
  };
  const changeSort = (column: FileSortColumn) => {
    const next = { column, direction: sort.column === column && sort.direction === "asc" ? "desc" as const : "asc" as const };
    setSort(next);
    saveFileSort(next);
  };
  const disabledReason = kind !== "ssh" ? t("browser.onlySsh") : t("browser.onlySftp");
  const refresh = () => { if (mounted.current) { ++request.current; setRevision(value => value + 1); } };
  const fail = (reason: unknown) => {
    if (!mounted.current) return;
    const message = backendErrorText(reason);
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
    const targets = targetsFor(contextEntry);
    if (action === "edit") { if (targets.length === 1) openEntry(targets[0]); return; }
    if (action === "rename") {
      // Renaming needs exactly one entry; with a multi-selection F2 and the button do nothing.
      const entry = targets.length === 1 ? targets[0] : undefined;
      if (!writable || busy || operation.current || !entry) return;
      renameTarget.current = entry.name;
      setSelection(selectSingle(current, order, entry.name));
      setRenaming(entry.name);
      return;
    }
    if (action === "chmod") {
      const entries = targets.filter(entry => entry.kind !== "symlink");
      if (!permissionsReady || !permissionsRoute || !listing || entries.length === 0 || operation.current) return;
      const route = permissionsRoute, targetDir = listing.path, targetId = sessionId;
      const anyDir = entries.some(entry => entry.kind === "dir");
      void run(async () => {
        const options = await ask<ChmodOptions | null>(answer => ({ type: "permissions", entry: entries[0], count: entries.length, anyDir, answer }));
        if (!options || !mounted.current) return;
        if (options.recursive && anyDir) {
          let count = 0;
          for (const entry of entries) count += entry.kind === "dir" ? await countPermissionEntries(route, targetId, childPath(targetDir, entry.name)) + 1 : 1;
          if (!mounted.current) return;
          const accepted = await ask<boolean>(answer => ({ type: "delete", message: tp("browser.chmodConfirm", count), confirmLabel: t("browser.chmodConfirmButton"), answer }));
          if (!accepted || !mounted.current) return;
        }
        const total = { changed: 0, failed: 0, errors: [] as string[] };
        for (const entry of entries) {
          // Files never recurse; the recursive options only matter for folders.
          const result = await changePermissions(route, targetId, childPath(targetDir, entry.name), entry.kind === "dir" ? options : { ...options, recursive: false, dirMode: null, fileMode: null });
          total.changed += result.changed;
          total.failed += result.failed;
          total.errors.push(...result.errors);
        }
        const message = total.errors.length
          ? t("browser.chmodResultErrors", { changed: total.changed, failed: total.failed, paths: total.errors.join(", ") })
          : t("browser.chmodResult", { changed: total.changed, failed: total.failed });
        callbacks.current.onStatus(message);
        if (total.failed && mounted.current) setError(message);
      });
      return;
    }
    if ((action === "sudo" ? !sudoReady : !writable || !listing) || sessionId === undefined || operation.current) return;
    const targetId = sessionId;
    const targetDir = listing?.path ?? path;
    const entry = targets.length === 1 ? targets[0] : undefined;
    void run(async () => {
      if (action === "sudo") {
        if (sudoActive) {
          await disableSudo(targetId);
          if (mounted.current) setSudoActive(false);
          if (id !== undefined) callbacks.current.onAccess(id, targetId, "sftp", false);
          callbacks.current.onStatus(t("browser.sudoDisabled"));
        } else {
          try { await enableSudo(targetId); }
          catch (reason: unknown) {
            if (errorCode(reason) !== "SUDO_PASSWORD") throw reason;
            const target = parseQuickConnect(tab?.target ?? "");
            const label = target ? `${target.user}@${target.host}` : tab?.title ?? t("browser.sshSession");
            let secret = await ask<string | null>(answer => ({ type: "sudo", label, answer }));
            if (secret === null || !mounted.current) return;
            try { await enableSudo(targetId, secret); } finally { secret = null; }
          }
          if (mounted.current) setSudoActive(true);
          if (id !== undefined) callbacks.current.onAccess(id, targetId, "sftp", true);
          callbacks.current.onStatus(t("browser.sudoEnabled"));
        }
      } else if (action === "upload") {
        const paths = await open({ multiple: true, directory: false, title: t("browser.selectFiles") });
        if (paths) transferQueue.enqueue(paths.map(localPath => ({ kind: "upload", sessionId: targetId, localPath, remoteDir: targetDir })));
      } else if (action === "uploadFolder") {
        const paths = await open({ multiple: true, directory: true, title: t("browser.selectFolders") });
        if (paths) transferQueue.enqueue(paths.map(localPath => ({ kind: "uploadFolder", sessionId: targetId, localPath, remoteDir: targetDir })));
      } else if (action === "download" && targets.length > 1) {
        // One target folder for all; one batch, so "Overwrite all" and Cancel cover every entry.
        const downloadable = targets.filter(item => item.kind !== "other");
        if (downloadable.length === 0) return;
        const localDir = await open({ multiple: false, directory: true, title: t("browser.selectTargetFolderMany", { count: downloadable.length }) });
        if (!localDir) return;
        const base = localDir.replace(/[\\/]+$/, ""), separator = sep();
        transferQueue.enqueue(downloadable.map(item => isDirectory(item)
          ? { kind: "downloadFolder" as const, sessionId: targetId, remotePath: remoteChild(targetDir, item.name), localParent: localDir }
          // Unlike the save dialog, nothing confirmed an existing file yet: ask on conflicts.
          : { kind: "download" as const, sessionId: targetId, remotePath: remoteChild(targetDir, item.name), localPath: `${base}${separator}${item.name}`, overwrite: false }));
      } else if (action === "download" && entry && isDirectory(entry)) {
        // The folder itself is created inside the chosen folder; existing folders are reused.
        const localParent = await open({ multiple: false, directory: true, title: t("browser.selectTargetFolder", { name: entry.name }) });
        if (!localParent) return;
        transferQueue.enqueue([{ kind: "downloadFolder", sessionId: targetId, remotePath: remoteChild(targetDir, entry.name), localParent }]);
      } else if (action === "download" && entry) {
        const localPath = await save({ defaultPath: entry.name, title: t("browser.saveFile") });
        if (!localPath) return;
        transferQueue.enqueue([{ kind: "download", sessionId: targetId, remotePath: remoteChild(targetDir, entry.name), localPath }]);
      } else if (action === "mkdir" || action === "create") {
        const name = await ask<string | null>(answer => ({ type: "name", directory: action === "mkdir", answer }));
        if (name === null || !mounted.current) return;
        await (action === "mkdir" ? makeDirectory : createFile)(targetId, targetDir, name);
      } else if (action === "delete" && targets.length > 1) {
        const names = targets.map(item => item.name);
        const folders = targets.filter(item => item.kind === "dir");
        let contained = 0;
        for (const item of folders) contained += await countEntries(targetId, remoteChild(targetDir, item.name));
        if (!mounted.current) return;
        const limit = 100000;
        const message = folders.length === 0 ? t("browser.deleteMany", { count: names.length, names: listNames(names) })
          : t("browser.deleteManyFolders", { count: names.length, names: listNames(names), entries: contained > limit ? t("browser.moreThan", { limit: limit.toLocaleString(currentLocale()) }) : contained.toLocaleString(currentLocale()) });
        const accepted = await ask<boolean>(answer => ({ type: "delete", message, answer }));
        if (!accepted || !mounted.current) return;
        // One after the other; a failed entry does not stop the rest.
        const failures: string[] = [];
        for (const item of targets) {
          try { await deleteEntry(targetId, remoteChild(targetDir, item.name), item.kind === "dir"); }
          catch (reason: unknown) { failures.push(`${item.name}: ${backendErrorText(reason)}`); }
        }
        if (failures.length) {
          const summary = t("browser.deleteManyFailed", { deleted: targets.length - failures.length, count: targets.length, errors: listNames(failures) });
          callbacks.current.onStatus(summary);
          if (mounted.current) setError(summary);
        }
      } else if (action === "delete" && entry) {
        const remotePath = remoteChild(targetDir, entry.name);
        const count = entry.kind === "dir" ? await countEntries(targetId, remotePath) : null;
        if (!mounted.current) return;
        const message = count === null ? t("browser.deleteFile", { name: entry.name })
          : count > 100000 ? t("browser.deleteFolderMany", { name: entry.name, limit: (100000).toLocaleString(currentLocale()) }) : tp("browser.deleteFolder", count, { name: entry.name });
        const accepted = await ask<boolean>(answer => ({ type: "delete", message, answer }));
        if (accepted && mounted.current) await deleteEntry(targetId, remotePath, entry.kind === "dir");
      }
    });
  };
  /** Right click or menu key: a selected entry keeps the selection, an unselected one becomes the only selection. */
  const openContext = (entry: DirEntry, x: number, y: number) => {
    const keep = isSelected(current, entry.name);
    setSelection(keep ? focusOnly(current, order, entry.name) : selectSingle(current, order, entry.name));
    setContext({ entry, x, y, count: keep ? selectedEntries.length : 1 });
  };
  const commitRename = (entry: DirEntry, value: string | null) => {
    if (renameTarget.current !== entry.name) return;
    renameTarget.current = null;
    setRenaming(null);
    focusSelected.current = true;
    if (value === null) return;
    const outcome = renameOutcome(entry.name, value);
    if (outcome.type === "keep") return;
    if (outcome.type === "invalid") { fail("INVALID_NAME"); return; }
    if (sessionId === undefined || !listing) return;
    const targetId = sessionId, targetDir = listing.path, newName = outcome.name;
    // On failure the reload keeps the old entry selected, on success the renamed one.
    pendingSelect.current = entry.name;
    void run(async () => {
      await renameEntry(targetId, targetDir, entry.name, newName);
      pendingSelect.current = newName;
      focusSelected.current = true;
      callbacks.current.onStatus(t("browser.renamed", { name: entry.name, newName }));
    });
  };
  // Parent effects run after the closed menu's cleanup restored the focus, so the name field keeps it.
  useEffect(() => {
    const entry = renameAfterMenu.current;
    if (context || !entry) return;
    renameAfterMenu.current = null;
    perform("rename", entry);
  }, [context]);
  const dropHandler = useRef({ writable, busy, uploadPaths, fail });
  dropHandler.current = { writable, busy, uploadPaths, fail };
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const linux = /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
    let scaleFactor = window.devicePixelRatio;
    const refreshScale = () => { if (linux) void getCurrentWindow().scaleFactor().then(value => { scaleFactor = value; }).catch(() => undefined); };
    refreshScale();
    void getCurrentWebview().onDragDropEvent(event => {
      if (disposed) return;
      const payload = event.payload;
      if (payload.type === "leave") { setDragOver(false); return; }
      if (payload.type === "enter") refreshScale();
      const rect = listRef.current?.getBoundingClientRect();
      const { x, y } = dropToCss(payload.position, { linux, scaleFactor, devicePixelRatio: window.devicePixelRatio });
      const inside = Boolean(rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
      const active = inside && dropHandler.current.writable && !dropHandler.current.busy;
      setDragOver(active && payload.type !== "drop");
      if (payload.type === "drop" && active) dropHandler.current.uploadPaths(payload.paths);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch((reason: unknown) => { if (!disposed) dropHandler.current.fail(reason); });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const heading = !tab ? t("browser.noSession") : kind === "ssh"
    ? `${t("browser.heading.ssh", { title: tab.title })}${listing ? ` (${listing.mode === "sftp" ? "SFTP" : "exec"})` : ""}`
    : kind === "wsl" ? t("browser.heading.wsl", { distro: distro ?? "…" }) : t("browser.heading.local");
  const notice = !tab ? t("browser.noSession") : kind === "wsl" && !distro
    ? t("browser.waitWsl")
    : kind === "ssh" && !ready ? (tab.exited ? t("browser.sshEnded") : t("browser.sshConnecting")) : null;

  return <>
    <div className="browser-settings">{settingLabels.map(setting => <label key={setting.key} title={t(setting.title)}><input type="checkbox" checked={settings[setting.key]} onChange={event => onSettings({ ...settings, [setting.key]: event.target.checked })} />{t(setting.label)}</label>)}</div>
    <h3 className="browser-heading">{heading}{kind === "ssh" && ready && sudoActive && <span className="sudo-badge">sudo</span>}</h3>
    <div className="browser-toolbar">{actions.map(action => {
      const viewAction = action.action === "up" || action.action === "refresh";
      const missingSelection = (action.action === "download" || action.action === "delete") ? selectedEntries.length === 0 : action.action === "rename" && !selectedEntry;
      const editAction = action.action === "edit";
      const sudoAction = action.action === "sudo";
      // Rename and the editor work on exactly one entry; the tooltip says why they are off.
      const singleOnly = multiple && (editAction || action.action === "rename");
      const disabled = sudoAction ? !sudoReady || busy : editAction ? !editorReady || busy || !selectedEntry || isDirectory(selectedEntry)
        : viewAction ? !ready : !writable || busy || !action.action || missingSelection;
      const label = t(action.label);
      const title = singleOnly ? t("browser.singleOnly") : editAction ? (kind === "ssh" && !editorReady ? t("browser.onlySftp") : label)
        : !viewAction && !(sudoAction ? sudoReady : writable) ? disabledReason : action.action === "upload" ? t("browser.uploadTitle") : label;
      return <button key={action.icon} type="button" aria-label={action.action === "sudo" ? t("browser.action.sudo.label") : label} aria-pressed={action.action === "sudo" ? sudoActive : undefined} title={title} disabled={Boolean(disabled)} aria-haspopup={action.action === "upload" ? "menu" : undefined} onClick={event => {
        if (action.action !== "upload") { perform(action.action); return; }
        const rect = event.currentTarget.getBoundingClientRect();
        setUploadMenu({ x: rect.left, y: rect.bottom + 2 });
      }}><Icon name={action.icon} /></button>;
    })}</div>
    <form onSubmit={event => { event.preventDefault(); navigate(input); }}><input className="remote-path" aria-label={t("browser.pathLabel")} placeholder={t("browser.pathPlaceholder")} value={input} disabled={!ready} onChange={event => setInput(event.target.value)} /></form>
    {notice && <p className="empty-state">{notice}</p>}
    {loading && <p className="empty-state" role="status">{t("browser.loading")}</p>}
    {error && <p className="browser-error" role="alert">{error}</p>}
    {listing && !loading && <div ref={listRef} className={`browser-list${dragOver ? " browser-drop-active" : ""}`} ><table role="grid" aria-multiselectable="true" aria-label={t("browser.listLabel")} style={{ minWidth: widths.name + widths.size + widths.modified }}><colgroup><col /><col style={{ width: widths.size }} /><col style={{ width: widths.modified }} /></colgroup><thead><tr>{([{ column: "name", label: t("browser.column.name") }, { column: "size", label: t("browser.column.size") }, { column: "modified", label: t("browser.column.modified") }] as const).map(header => <th key={header.column} scope="col" aria-sort={sort.column === header.column ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}><button type="button" onClick={() => changeSort(header.column)}>{header.label}{sort.column === header.column && <span aria-hidden="true"> {sort.direction === "asc" ? "▲" : "▼"}</span>}</button><ResizeGrip label={t("browser.columnWidth", { column: header.label })} value={widths[header.column]} measure={() => listRef.current?.querySelectorAll("th")[{ name: 0, size: 1, modified: 2 }[header.column]]?.getBoundingClientRect().width ?? widths[header.column]} min={header.column === "name" ? 100 : header.column === "size" ? 55 : 90} onResize={value => resizeColumn(header.column, value)} onAuto={() => autoColumn(header.column)} /></th>)}</tr></thead><tbody>{sortedEntries.map(entry => <tr key={entry.name} title={modeToRwx(entry.permissions)} onContextMenu={event => { if ((!writable && !editorReady) || busy) return; event.preventDefault(); openContext(entry, event.clientX, event.clientY); }} tabIndex={entry.name === focusName ? 0 : -1} aria-selected={isSelected(current, entry.name)} className={isSelected(current, entry.name) ? "browser-selected" : ""} aria-label={t(isDirectory(entry) ? "browser.entryFolder" : "browser.entryFile", { name: entry.name })}
      onMouseDown={event => {
        pointerFocus.current = true;
        // Shift+click must not select text; the row then gets the focus from the effect.
        if (event.shiftKey) { event.preventDefault(); focusSelected.current = true; }
      }}
      onClick={event => { pointerFocus.current = false; setSelection(event.shiftKey ? selectRange(current, order, entry.name) : event.ctrlKey || event.metaKey ? toggle(current, order, entry.name) : selectSingle(current, order, entry.name)); }}
      onFocus={() => {
        // Mouse: the click decides. Keyboard (Tab): an empty selection selects the row, otherwise only the focus moves.
        const pointer = pointerFocus.current;
        pointerFocus.current = false;
        if (pointer || current.focus === entry.name) return;
        setSelection(current.names.length ? focusOnly(current, order, entry.name) : selectSingle(current, order, entry.name));
      }} onDoubleClick={() => { if (isDirectory(entry)) navigate(childPath(listing.path, entry.name)); else openEntry(entry); }} onKeyDown={event => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        if ((writable || editorReady) && !busy) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openContext(entry, rect.left + 12, rect.bottom); }
      }
      if (event.key === "Enter") { event.preventDefault(); if (isDirectory(entry)) navigate(childPath(listing.path, entry.name)); else openEntry(entry); }
      if (event.key === "Delete") { event.preventDefault(); if (writable && !busy) perform("delete"); }
      if (event.key === "F2") { event.preventDefault(); if (!multiple) perform("rename", entry); }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "a") { event.preventDefault(); setSelection(selectAll(current, order)); }
      if (event.key === "Escape") setSelection(collapseToFocus(focusOnly(current, order, entry.name), order));
      const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "Home" ? "start" as const : event.key === "End" ? "end" as const : null;
      if (delta !== null) {
        event.preventDefault();
        // The focused row is the starting point; the effect moves the DOM focus after the render.
        setSelection(moveFocus(focusOnly(current, order, entry.name), order, delta, event.shiftKey));
        focusSelected.current = true;
      }
    }}><td><span className="browser-entry-name"><Icon name={isDirectory(entry) ? "folder" : "file"} />{renaming === entry.name
      ? <InlineRename name={entry.name} file={!isDirectory(entry)} label={t("browser.renameLabel", { name: entry.name })} onDone={value => commitRename(entry, value)} />
      : <span title={entry.name}>{entry.name}</span>}</span></td><td>{isDirectory(entry) ? "—" : formatSize(entry.size)}</td><td>{entry.modified === null ? "—" : new Date(entry.modified * 1000).toLocaleString(currentLocale(), { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "")}</td></tr>)}</tbody></table>{listing.entries.length === 0 && <p className="empty-state">{t("browser.empty")}</p>}</div>}
    {listing && !loading && multiple && <p className="browser-selection-count" role="status">{t("browser.selectedCount", { count: selectedEntries.length })}</p>}
    {context && <BrowserContextMenu {...context} renameDisabled={!writable} permissionsDisabled={!permissionsReady || ((context.count ?? 1) > 1 && targetsFor(context.entry).every(entry => entry.kind === "symlink"))} permissionsTitle={permissionsRoute === null && listing?.mode === "local" ? t("browser.unixPermissionsUnavailable") : t("browser.onlySftp")} markedName={markedSource ? markedSource.path.split(/[\\/]/).pop() : undefined} onAnswer={action => { const entry = context.entry; setContext(null); if ((action === "remember" || action === "compare") && tab && listing) onCompareFile?.({ tab, path: childPath(listing.path, entry.name) }, action === "remember"); else if (action === "rename") renameAfterMenu.current = entry; else if (action && action !== "remember" && action !== "compare") perform(action, entry); }} />}
    {uploadMenu && <UploadMenu {...uploadMenu} onAnswer={choice => { setUploadMenu(null); if (choice) perform(choice); }} />}
    {prompt?.type === "sudo" ? <SecretDialog key={promptSequence} title={t("browser.sudoPasswordTitle", { label: prompt.label })} prompt={{ type: "secret", requestId: 0, kind: "password", label: prompt.label }} onAnswer={prompt.answer} />
      : prompt?.type === "permissions" ? <PermissionsDialog key={promptSequence} entry={prompt.entry} count={prompt.count} anyDir={prompt.anyDir} onAnswer={prompt.answer} />
      : prompt && <FileActionDialog key={promptSequence} prompt={prompt} />}
  </>;
}
