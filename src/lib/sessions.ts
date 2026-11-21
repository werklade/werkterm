import { invoke } from "@tauri-apps/api/core";
import { getLanguage, t } from "../i18n";
import { checkSshOptions, MAX_SSH_OPTION_LINES, MAX_SSH_OPTIONS_LENGTH } from "./sshOptions";

export interface SerialConfig { device: string; baud: number; data_bits: number; parity: "none" | "odd" | "even"; stop_bits: number; flow: "none" | "software" | "hardware"; enter: "cr" | "lf" | "crlf"; local_echo: boolean }
export const defaultSerial: SerialConfig = { device: "", baud: 115200, data_bits: 8, parity: "none", stop_bits: 1, flow: "none", enter: "cr", local_echo: false };
export type ImportSource = "mobaxterm" | "windterm";
export type SessionAuth =
  | { type: "default" }
  | { type: "keyFile"; path: string }
  | { type: "password" }
  | { type: "ask" };

export interface SavedSession {
  kind: string;
  serial?: SerialConfig | null;
  id: string;
  name: string;
  folder: string;
  host: string;
  port: number;
  user: string | null;
  auth: SessionAuth;
  source: ImportSource | null;
  keepaliveInterval?: number;
  keepaliveMax?: number;
  jumpSessionId?: string | null;
  log_always?: boolean;
  /** OpenSSH-style options, one `Key=Value` per line (SSH only). */
  sshOptions?: string;
}

export interface ImportCandidate {
  key: string;
  name: string;
  folder: string;
  host: string;
  port: number;
  user: string | null;
  keyPath: string | null;
  oneKey: string | null;
  duplicateOf: string | null;
}

export interface OneKeyRef { uuid: string; name: string; kind: string }
export interface ImportGateway { host: string; port: number; user: string }
export interface ImportPreview {
  candidates: ImportCandidate[];
  oneKeys: OneKeyRef[];
  skipped: number;
  warnings: string[];
  gateways?: Record<string, ImportGateway>;
}
export interface ImportSelection {
  candidate: ImportCandidate;
  gateway?: ImportGateway;
  user: string | null;
  auth: SessionAuth;
}
export interface OneKeyMapping { user: string | null; auth: SessionAuth }
export interface ImportResult { imported: number; skippedDuplicates: number; warnings?: string[] }
export interface SessionFolder {
  name: string;
  path: string;
  folders: SessionFolder[];
  sessions: SavedSession[];
}

export const listSessions = () => invoke<SavedSession[]>("sessions_list");
/** Empty folders; folders holding sessions follow from the sessions. */
export const listSessionFolders = () => invoke<string[]>("sessions_folders");
/** Folder of a session before (`folder`) and after (`expected`) a change. */
export interface FolderAssignment { id: string; folder: string; expected: string }
/** What a change did: moved sessions and the empty folders it added or removed. Undo turns back only this. */
export interface LayoutSnapshot { sessions: FolderAssignment[]; added: string[]; removed: string[] }
/** `changed === false`: nothing was written. `moved`: sessions whose folder changed. `skipped` (undo only): sessions
 * left alone because they were deleted or moved elsewhere in the meantime. */
export interface LayoutChange { changed: boolean; moved: number; skipped: number; undo: LayoutSnapshot }
export const moveSessions = (ids: string[], folder: string) => invoke<LayoutChange>("sessions_move", { ids, folder });
export const renameSessionFolder = (from: string, to: string) => invoke<LayoutChange>("sessions_rename_folder", { from, to });
export const restoreSessionLayout = (layout: LayoutSnapshot) => invoke<LayoutChange>("sessions_restore_layout", { layout });
export const createSessionFolder = (path: string) => invoke<void>("sessions_create_folder", { path });
export const removeSessionFolder = (path: string) => invoke<void>("sessions_remove_folder", { path });
/** Deletes a folder with all its sessions and empty subfolders in one write. */
export const deleteSessionFolder = (folder: string) => invoke<DeleteManyResult>("sessions_delete_folder", { folder });
export const saveSession = (session: SavedSession, password: string | null) =>
  invoke<SavedSession>("sessions_save", { session, password });
export const deleteSession = (id: string) => invoke<void>("sessions_delete", { id });
export interface DeleteManyResult { deleted: string[]; blocked: { id: string; name: string; reason: string }[]; warnings: string[] }
export const deleteSessions = (ids: string[]) => invoke<DeleteManyResult>("sessions_delete_many", { ids });
export const keyringAvailable = () => invoke<boolean>("sessions_keyring_available");

/** Existing sessions retain their authentication; quick-connect drafts prefer the keyring. */
export function initialSessionAuthType(
  session: SavedSession | undefined, preferPassword: boolean, keyring: boolean,
): SessionAuth["type"] {
  if (session?.id) return session.auth.type;
  if (preferPassword) return keyring ? "password" : "ask";
  return session?.auth.type ?? "default";
}
export const importDefaultPath = (source: ImportSource) =>
  invoke<string | null>("sessions_import_default_path", { source });
export const previewImport = (source: ImportSource, path: string) =>
  invoke<ImportPreview>("sessions_import_preview", { source, path });
export const commitImport = (candidates: ImportSelection[]) =>
  invoke<ImportResult>("sessions_import_commit", { candidates });

/** Same rules as the backend: segments split at "/", trimmed, empty ones dropped. "" is the top level. */
export function normalizeFolder(path: string): string {
  return path.split("/").map(trimFolderSegment).filter(Boolean).join("/");
}
/**
 * Whitespace trimmed from folder segments, identical to `is_trimmed` in the backend: ASCII space, \t, \n, \r, \f, \v,
 * the Unicode space separators (Zs) and U+FEFF. Deliberately not String.prototype.trim (which also trims U+2028/9).
 */
const trimPattern = /^[ \t\n\r\f\v\p{Zs}\uFEFF]+|[ \t\n\r\f\v\p{Zs}\uFEFF]+$/gu;
export const trimFolderSegment = (segment: string) => segment.replace(trimPattern, "");
/** `path` is `root` or lies below it; everything lies within the top level "". */
export function isWithinFolder(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(`${root}/`);
}
export const parentFolder = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
export const folderName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const joinFolder = (parent: string, name: string) => normalizeFolder(parent ? `${parent}/${name}` : name);

/** A folder name for rename/create: not empty, no "/" and no control characters. */
export function validFolderName(name: string): boolean {
  return name.trim() !== "" && !name.includes("/") && !/\p{Cc}/u.test(name);
}

/** Folder paths are logical session categories, not operating-system paths. Empty folders come from `folders`. */
export function buildSessionTree(sessions: readonly SavedSession[], folders: readonly string[] = []): SessionFolder {
  const root: SessionFolder = { name: "", path: "", folders: [], sessions: [] };
  const open = (path: string) => {
    let folder = root;
    for (const name of normalizeFolder(path).split("/").filter(Boolean)) {
      const childPath = folder.path ? `${folder.path}/${name}` : name;
      let child = folder.folders.find(item => item.path === childPath);
      if (!child) {
        child = { name, path: childPath, folders: [], sessions: [] };
        folder.folders.push(child);
      }
      folder = child;
    }
    return folder;
  };
  for (const path of folders) open(path);
  for (const session of sessions) open(session.folder).sessions.push(session);
  const sort = (folder: SessionFolder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name, getLanguage()));
    folder.sessions.sort((a, b) => a.name.localeCompare(b.name, getLanguage()));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
}

export function searchSessions(sessions: readonly SavedSession[], query: string): SavedSession[] {
  const term = query.trim().toLocaleLowerCase(getLanguage());
  return sessions.filter(session => [session.name, session.host, session.serial?.device ?? "", session.user ?? ""]
    .some(value => value.toLocaleLowerCase(getLanguage()).includes(term)));
}

type SessionTarget = Pick<SavedSession, "host" | "port" | "user"> & Partial<Pick<SavedSession, "kind" | "serial">>;

export function sessionLabel(session: Pick<SessionTarget, "host" | "user"> & Partial<Pick<SavedSession, "kind" | "serial" | "port">>): string {
  if (session.kind === "serial") return `${session.serial?.device ?? ""}@${session.serial?.baud ?? 115200}`;
  if (session.kind === "telnet") return `${session.host.includes(":") ? `[${session.host}]` : session.host}:${session.port ?? 23}`;
  return session.user ? `${session.user}@${session.host}` : session.host;
}

export function sessionTarget(session: SessionTarget, userOverride?: string): string {
  if (session.kind === "serial") return `serial://${session.serial?.device ?? ""}@${session.serial?.baud ?? 115200}`;
  if (session.kind === "telnet") return `telnet://${session.host.includes(":") ? `[${session.host}]` : session.host}:${session.port}`;
  const host = session.host.includes(":") && !session.host.startsWith("[")
    ? `[${session.host}]` : session.host;
  const user = userOverride ?? session.user;
  return `${user ? `${user}@` : ""}${host}:${session.port}`;
}

export function defaultImportSelection(candidates: readonly ImportCandidate[]): Set<string> {
  return new Set(candidates.filter(candidate => candidate.duplicateOf === null).map(candidate => candidate.key));
}

export function applyOneKeyMappings(
  candidates: readonly ImportCandidate[],
  mappings: Readonly<Record<string, OneKeyMapping>>,
): ImportSelection[] {
  return candidates.map(candidate => {
    const mapping = candidate.oneKey && Object.prototype.hasOwnProperty.call(mappings, candidate.oneKey)
      ? mappings[candidate.oneKey] : undefined;
    return {
      candidate,
      user: candidate.user === null && mapping ? mapping.user : candidate.user,
      auth: mapping ? { ...mapping.auth } : candidate.keyPath
        ? { type: "keyFile", path: candidate.keyPath } : { type: "default" },
    };
  });
}

/** Recheck final targets after OneKey users have been applied. */
export function markImportDuplicates(
  selections: readonly ImportSelection[], sessions: readonly SavedSession[],
): ImportSelection[] {
  return selections.map(selection => {
    const duplicate = sessions.find(session => session.kind === "ssh"
      && session.host.toLowerCase() === selection.candidate.host.toLowerCase()
      && session.port === selection.candidate.port && session.user === selection.user);
    return { ...selection, candidate: { ...selection.candidate, duplicateOf: duplicate?.id ?? null } };
  });
}

export function deselectNewImportDuplicates(
  selected: ReadonlySet<string>, previous: readonly ImportSelection[], next: readonly ImportSelection[],
): Set<string> {
  const previousDuplicates = new Set(previous.filter(item => item.candidate.duplicateOf !== null).map(item => item.candidate.key));
  const newlyDuplicated = new Set(next.filter(item => item.candidate.duplicateOf !== null
    && !previousDuplicates.has(item.candidate.key)).map(item => item.candidate.key));
  return new Set([...selected].filter(key => !newlyDuplicated.has(key)));
}

/** Matches the persisted backend validation before attempting an IPC call. */
export function validateSession(session: SavedSession): string | null {
  if (!Number.isInteger(session.keepaliveInterval ?? 30) || (session.keepaliveInterval ?? 30) < 0 || (session.keepaliveInterval ?? 30) > 3600 || !Number.isInteger(session.keepaliveMax ?? 3) || (session.keepaliveMax ?? 3) < 1 || (session.keepaliveMax ?? 3) > 100) return t("session.validate.keepalive");
  if (!session.name.trim()) return t("session.validate.nameEmpty");
  if (!["ssh", "telnet", "serial"].includes(session.kind)) return t("session.validate.unknownKind");
  if (session.kind !== "ssh" && (session.jumpSessionId || session.auth.type !== "default" || session.sshOptions)) return t("session.validate.sshOnly");
  if (session.kind === "serial") {
    const c = session.serial;
    return !c || !c.device.trim() || /\p{Cc}/u.test(c.device) || !Number.isInteger(c.baud) || c.baud < 1 || c.baud > 4294967295 || ![5,6,7,8].includes(c.data_bits) || ![1,2].includes(c.stop_bits) || !["none","odd","even"].includes(c.parity) || !["none","software","hardware"].includes(c.flow) || !["cr","lf","crlf"].includes(c.enter) ? t("session.validate.serial") : null;
  }
  if (!session.host || /[\s\p{Cc}]/u.test(session.host)) return t("session.validate.host");
  if (!Number.isInteger(session.port) || session.port < 1 || session.port > 65535) return t("session.validate.port");
  if (session.auth.type === "keyFile" && !session.auth.path.trim()) return t("session.validate.keyPath");
  return sshOptionsError(session.sshOptions ?? "");
}

/** Translated syntax error of the SSH option text, or null. Algorithm names are checked by the backend. */
export function sshOptionsError(text: string): string | null {
  const problem = checkSshOptions(text);
  if (!problem) return null;
  if (problem.kind === "tooLong") return t("session.validate.sshOptions.tooLong", { lines: String(MAX_SSH_OPTION_LINES), chars: String(MAX_SSH_OPTIONS_LENGTH) });
  if (problem.kind === "malformed") return t("session.validate.sshOptions.malformed", { line: String(problem.line) });
  return t(problem.kind === "unknown" ? "session.validate.sshOptions.unknown" : "session.validate.sshOptions.duplicate", { line: String(problem.line), key: problem.key });
}

/** Reject self references, existing cycles, missing hops and chains beyond five gateways. */
export function jumpHostOptions(sessions: readonly SavedSession[], sessionId?: string): SavedSession[] {
  const byId = new Map(sessions.map(session => [session.id, session]));
  return sessions.filter(candidate => {
    const seen = new Set(sessionId ? [sessionId] : []);
    let hop: SavedSession | undefined = candidate;
    let count = 0;
    while (hop) {
      if (hop.kind !== "ssh" || seen.has(hop.id) || ++count > 5) return false;
      seen.add(hop.id);
      if (!hop.jumpSessionId) return true;
      hop = byId.get(hop.jumpSessionId);
    }
    return false;
  });
}

export function jumpHostHint(session: SavedSession, sessions: readonly SavedSession[]): string {
  if (!session.jumpSessionId) return "";
  return t("session.jumpVia", { name: sessions.find(item => item.id === session.jumpSessionId)?.name ?? t("session.jumpUnknown") });
}

export interface SessionSelection { ids: string[]; anchor: string }
export function selectSessions(previous: SessionSelection, visible: readonly string[], target: string, action: "single" | "toggle" | "range" | "all"): SessionSelection {
  if (action === "all") return { ids: [...visible], anchor: visible.includes(previous.anchor) ? previous.anchor : visible[0] ?? "" };
  if (action === "range") {
    const end = visible.indexOf(target);
    const start = visible.indexOf(previous.anchor);
    if (end < 0) return previous;
    if (start >= 0) return { ids: visible.slice(Math.min(start, end), Math.max(start, end) + 1), anchor: previous.anchor };
  }
  if (action === "toggle") return { ids: previous.ids.includes(target) ? previous.ids.filter(id => id !== target) : [...previous.ids, target], anchor: target };
  return { ids: target ? [target] : [], anchor: target };
}
export function collectFolderSessions(folder: SessionFolder): SavedSession[] {
  return [...folder.sessions, ...folder.folders.flatMap(collectFolderSessions)];
}
/** Every folder path (with all parents), sorted, without the top level. */
export function allFolderPaths(sessions: readonly SavedSession[], folders: readonly string[] = []): string[] {
  const paths: string[] = [];
  const walk = (folder: SessionFolder) => { for (const child of folder.folders) { paths.push(child.path); walk(child); } };
  walk(buildSessionTree(sessions, folders));
  return paths;
}

/** What is being dragged or moved: sessions (one or the selection) or one folder. */
export type MoveItem = { kind: "sessions"; ids: string[] } | { kind: "folder"; path: string };
/** Target folder of a drop/move: never into the own subtree and never where everything already is. */
export function moveAllowed(item: MoveItem, target: string, sessions: readonly SavedSession[]): boolean {
  if (item.kind === "folder") return item.path !== "" && !isWithinFolder(target, item.path) && parentFolder(item.path) !== target;
  const moving = sessions.filter(session => item.ids.includes(session.id));
  return moving.length > 0 && moving.some(session => normalizeFolder(session.folder) !== target);
}
/** New path of a folder moved into `target`. */
export const movedFolderPath = (path: string, target: string) => joinFolder(target, folderName(path));

export interface WerktermImportPreview {
  sessions: SavedSession[];
  duplicateOf: (string | null)[];
  warnings: string[];
}
export const exportSessions = (ids: string[], path: string) =>
  invoke<number>("sessions_export", { ids, path });
export const previewWerktermImport = (path: string) =>
  invoke<WerktermImportPreview>("sessions_export_preview", { path });
export const importWerktermSessions = (path: string, ids: string[]) =>
  invoke<ImportResult>("sessions_import_werkterm", { path, ids });
