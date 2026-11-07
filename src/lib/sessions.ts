import { invoke } from "@tauri-apps/api/core";

export type ImportSource = "mobaxterm" | "windterm";
export type SessionAuth =
  | { type: "default" }
  | { type: "keyFile"; path: string }
  | { type: "password" }
  | { type: "ask" };

export interface SavedSession {
  kind: string;
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
export interface ImportPreview {
  candidates: ImportCandidate[];
  oneKeys: OneKeyRef[];
  skipped: number;
  warnings: string[];
}
export interface ImportSelection {
  candidate: ImportCandidate;
  user: string | null;
  auth: SessionAuth;
}
export interface OneKeyMapping { user: string | null; auth: SessionAuth }
export interface ImportResult { imported: number; skippedDuplicates: number }
export interface SessionFolder {
  name: string;
  path: string;
  folders: SessionFolder[];
  sessions: SavedSession[];
}

export const listSessions = () => invoke<SavedSession[]>("sessions_list");
export const saveSession = (session: SavedSession, password: string | null) =>
  invoke<SavedSession>("sessions_save", { session, password });
export const deleteSession = (id: string) => invoke<void>("sessions_delete", { id });
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

/** Folder paths are logical session categories, not operating-system paths. */
export function buildSessionTree(sessions: readonly SavedSession[]): SessionFolder {
  const root: SessionFolder = { name: "", path: "", folders: [], sessions: [] };
  for (const session of sessions) {
    let folder = root;
    for (const name of session.folder.split("/").filter(Boolean)) {
      const path = folder.path ? `${folder.path}/${name}` : name;
      let child = folder.folders.find(item => item.path === path);
      if (!child) {
        child = { name, path, folders: [], sessions: [] };
        folder.folders.push(child);
      }
      folder = child;
    }
    folder.sessions.push(session);
  }
  const sort = (folder: SessionFolder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name, "de"));
    folder.sessions.sort((a, b) => a.name.localeCompare(b.name, "de"));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
}

export function searchSessions(sessions: readonly SavedSession[], query: string): SavedSession[] {
  const term = query.trim().toLocaleLowerCase("de");
  return sessions.filter(session => [session.name, session.host, session.user ?? ""]
    .some(value => value.toLocaleLowerCase("de").includes(term)));
}

type SessionTarget = Pick<SavedSession, "host" | "port" | "user">;

export function sessionLabel(session: Pick<SessionTarget, "host" | "user">): string {
  return session.user ? `${session.user}@${session.host}` : session.host;
}

export function sessionTarget(session: SessionTarget, userOverride?: string): string {
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
    const duplicate = sessions.find(session => session.host.toLowerCase() === selection.candidate.host.toLowerCase()
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
  if (!Number.isInteger(session.keepaliveInterval ?? 30) || (session.keepaliveInterval ?? 30) < 0 || (session.keepaliveInterval ?? 30) > 3600 || !Number.isInteger(session.keepaliveMax ?? 3) || (session.keepaliveMax ?? 3) < 1 || (session.keepaliveMax ?? 3) > 100) return "Keepalive: Intervall 0–3600, Maximum 1–100";
  if (!session.name.trim()) return "Sitzungsname darf nicht leer sein";
  if (!session.host || /[\s\p{Cc}]/u.test(session.host)) return "Host darf nicht leer sein oder Leerzeichen enthalten";
  if (!Number.isInteger(session.port) || session.port < 1 || session.port > 65535) return "Port muss zwischen 1 und 65535 liegen";
  if (session.auth.type === "keyFile" && !session.auth.path.trim()) return "Schlüsselpfad darf nicht leer sein";
  return null;
}
