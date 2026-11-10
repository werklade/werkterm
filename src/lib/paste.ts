export type PasteConfirm = "multiline" | "always" | "never";
export function hasPasteControls(text: string): boolean { return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text); }
export function shouldConfirmPaste(text: string, mode: PasteConfirm): boolean {
  return hasPasteControls(text) || (mode !== "never" && (mode === "always" || text.length > 1024 || /[\r\n]/.test(text)));
}
export function stripLastNewline(text: string): string { return text.replace(/(?:\r\n|\n|\r)$/, ""); }
export function singleLinePaste(text: string): string { return text.replace(/\r\n|\r|\n/g, " "); }

export type PasteAction = "paste" | "single-line";
export interface PasteChoice { action: PasteAction; trim: boolean }
/** "none" = do not remember; "tab" = this terminal tab (memory only); "profile" = saved session; "global" = all terminals. */
export type RememberScope = "none" | "tab" | "profile" | "global";
export interface PasteRemember { global: PasteChoice | null; sessions: Record<string, PasteChoice> }
export const maxRememberedSessions = 500;
const maxSessionIdLength = 128;
export function emptyPasteRemember(): PasteRemember { return { global: null, sessions: {} }; }

function isOwnKey(record: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(record, key); }
export function normalizePasteChoice(value: unknown): PasteChoice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if ((v.action !== "paste" && v.action !== "single-line") || typeof v.trim !== "boolean") return null;
  return { action: v.action, trim: v.trim };
}
export function normalizePasteRemember(value: unknown): PasteRemember {
  const result = emptyPasteRemember();
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const v = value as Record<string, unknown>;
  result.global = normalizePasteChoice(v.global);
  const sessions = v.sessions;
  if (sessions && typeof sessions === "object" && !Array.isArray(sessions)) {
    let count = 0;
    for (const key of Object.keys(sessions)) {
      if (count >= maxRememberedSessions) break;
      if (!key || key.length > maxSessionIdLength || key === "__proto__") continue;
      const choice = normalizePasteChoice((sessions as Record<string, unknown>)[key]);
      if (choice) { result.sessions[key] = choice; count++; }
    }
  }
  return result;
}

/**
 * Remembered choice for a paste that would trigger a prompt: tab, then profile, then global. Null means ask.
 * Callers only consult this when shouldConfirmPaste is true: with pasteConfirm "never" nothing is ever asked
 * and a remembered action deliberately does not apply (the text is pasted unchanged).
 */
export function resolveRemembered(input: { text: string; multiExec: boolean; tabChoice?: PasteChoice | null; sessionId?: string | null; remember: PasteRemember }): PasteChoice | null {
  if (hasPasteControls(input.text)) return null;
  const { remember } = input;
  if (input.multiExec) return remember.global;
  if (input.tabChoice) return input.tabChoice;
  if (input.sessionId && isOwnKey(remember.sessions, input.sessionId)) return remember.sessions[input.sessionId];
  return remember.global;
}
export function availableScopes(input: { controls: boolean; multiExec: boolean; hasProfile: boolean }): Record<RememberScope, boolean> {
  if (input.controls) return { none: true, tab: false, profile: false, global: false };
  return { none: true, tab: !input.multiExec, profile: !input.multiExec && input.hasProfile, global: true };
}
/** Scope that really applies: unavailable scopes fall back to "none". */
export function effectiveScope(scope: RememberScope, available: Record<RememberScope, boolean>): RememberScope { return available[scope] ? scope : "none"; }
export function applyPasteChoice(text: string, choice: PasteChoice): string {
  const value = choice.trim ? stripLastNewline(text) : text;
  return choice.action === "single-line" ? singleLinePaste(value) : value;
}
/** Stores a choice for "profile" or "global"; other scopes and a missing session id leave the data unchanged. */
export function rememberChoice(remember: PasteRemember, scope: RememberScope, sessionId: string | null | undefined, choice: PasteChoice): PasteRemember {
  if (scope === "global") return { global: { ...choice }, sessions: remember.sessions };
  if (scope !== "profile" || !sessionId || sessionId.length > maxSessionIdLength || sessionId === "__proto__") return remember;
  if (!isOwnKey(remember.sessions, sessionId) && Object.keys(remember.sessions).length >= maxRememberedSessions) return remember;
  return { global: remember.global, sessions: { ...remember.sessions, [sessionId]: { ...choice } } };
}
export function resetRemembered(): PasteRemember { return emptyPasteRemember(); }
export function resetRememberedSession(remember: PasteRemember, sessionId: string): PasteRemember {
  if (!isOwnKey(remember.sessions, sessionId)) return remember;
  const sessions = { ...remember.sessions };
  delete sessions[sessionId];
  return { global: remember.global, sessions };
}
/** Drops entries of sessions that no longer exist. Returns the same object when nothing changes. */
export function pruneRemembered(remember: PasteRemember, existingIds: Iterable<string>): PasteRemember {
  const keep = new Set(existingIds);
  const keys = Object.keys(remember.sessions);
  if (keys.every(key => keep.has(key))) return remember;
  const sessions: Record<string, PasteChoice> = {};
  for (const key of keys) if (keep.has(key)) sessions[key] = remember.sessions[key];
  return { global: remember.global, sessions };
}
export function hasRemembered(remember: PasteRemember, tabCount = 0): boolean { return remember.global !== null || Object.keys(remember.sessions).length > 0 || tabCount > 0; }
export function describeRemembered(remember: PasteRemember, tabCount = 0): string {
  const parts: string[] = [];
  if (remember.global) parts.push("dauerhaft");
  const count = Object.keys(remember.sessions).length;
  if (count > 0) parts.push(count === 1 ? "1 Profil" : `${count} Profile`);
  if (tabCount > 0) parts.push(tabCount === 1 ? "1 Tab" : `${tabCount} Tabs`);
  return parts.length ? `Gemerkt: ${parts.join(", ")}` : "Nichts gemerkt";
}
