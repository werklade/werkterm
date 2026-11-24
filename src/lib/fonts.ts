import { invoke } from "@tauri-apps/api/core";
import { defaultSettings } from "./settings";

export type FontStyle = "normal" | "italic" | "oblique";
export interface SystemFont { family: string; monospaced: boolean }
export interface ImportedFont { id: string; family: string; monospaced: boolean; weight: number; style: FontStyle; broken?: boolean }
/** All imported faces (weights/styles) of one family; the select shows each family once. */
export interface ImportedFamily { key: string; family: string; monospaced: boolean; broken: boolean; ids: string[] }

export const fontsChangedEvent = "werkterm:fonts-changed";

/** CSS value stored for a chosen family: `"X", monospace`. Quotes and backslashes are removed from X. */
export function buildFontFamily(family: string): string {
  const clean = family.replace(/["'\\;]/g, "").trim();
  return clean ? `"${clean}", monospace` : defaultSettings.fontFamily;
}

/** First family of a stored CSS font list, without quotes. */
export function firstFontFamily(value: string): string {
  const text = value.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1);
    if (end > 0) return text.slice(1, end).trim();
  }
  return (text.split(",")[0] ?? "").replace(/["']/g, "").trim();
}

export const isDefaultFontFamily = (value: string): boolean => value.trim() === defaultSettings.fontFamily;

/** CSS family names match case-insensitively; this key compares system and imported families the same way. */
export const fontKey = (family: string): string => family.trim().toLowerCase();

/** Whether a stored value selects the family (case-insensitive, like CSS). */
export const fontFamilyMatches = (value: string, family: string): boolean => fontKey(buildFontFamily(family)) === fontKey(value);

/** Whether a stored value is exactly what buildFontFamily produces for one of the families. */
export function isKnownFontFamily(value: string, families: readonly string[]): boolean {
  if (isDefaultFontFamily(value)) return true;
  return families.some(family => buildFontFamily(family) === value.trim());
}

/** Groups faces by family (case-insensitive), sorted by name. A family is broken when one of its faces failed to load. */
export function groupImportedFonts(fonts: readonly ImportedFont[]): ImportedFamily[] {
  const families = new Map<string, ImportedFamily>();
  for (const font of fonts) {
    const key = fontKey(font.family);
    const entry = families.get(key);
    if (entry) { entry.ids.push(font.id); entry.monospaced ||= font.monospaced; entry.broken ||= !!font.broken; }
    else families.set(key, { key, family: font.family, monospaced: font.monospaced, broken: !!font.broken, ids: [font.id] });
  }
  return [...families.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** System families without those an imported family shadows; one entry per case-insensitive name. */
export function visibleSystemFonts(system: readonly SystemFont[], importedKeys: ReadonlySet<string>, showAll: boolean, selectedKey?: string): SystemFont[] {
  const shown = new Map<string, SystemFont>();
  for (const font of system) {
    const key = fontKey(font.family);
    if (importedKeys.has(key) || shown.has(key)) continue;
    if (showAll || font.monospaced || key === selectedKey) shown.set(key, font);
  }
  return [...shown.values()];
}

const registered = new Map<string, FontFace>();
/** Registrations in flight, so parallel calls for one font share a single FontFace. */
const pending = new Map<string, { promise: Promise<void> }>();
const failed = new Set<string>();
let known: ImportedFont[] = [];

const withState = (font: ImportedFont): ImportedFont => ({ ...font, broken: failed.has(font.id) });

/** Imported fonts as last listed; broken marks faces that could not be loaded. */
export const importedFontsSnapshot = (): ImportedFont[] => known.map(withState);

/**
 * Registers every imported font with the document and drops registrations of fonts no longer listed.
 * A broken font stays in the result (marked broken) so it can be removed; throws only if listing fails.
 */
export async function loadImportedFonts(): Promise<ImportedFont[]> {
  const list = await invoke<ImportedFont[]>("fonts_list_imported");
  known = list;
  const ids = new Set(list.map(font => font.id));
  let changed = false;
  for (const id of new Set([...registered.keys(), ...pending.keys(), ...failed])) {
    if (ids.has(id)) continue;
    changed ||= registered.has(id);
    forget(id);
  }
  await Promise.all(list.map(async font => {
    if (registered.has(font.id) || failed.has(font.id)) return;
    try { await registerImportedFont(font); changed = true; }
    catch (reason) { failed.add(font.id); console.warn(`font ${font.id} not usable`, reason); }
  }));
  if (changed) window.dispatchEvent(new Event(fontsChangedEvent));
  return list.map(withState);
}

export function registerImportedFont(font: ImportedFont): Promise<void> {
  if (registered.has(font.id)) return Promise.resolve();
  const running = pending.get(font.id);
  if (running) return running.promise;
  // The token identifies this registration; unregistering replaces or removes it.
  const token = { promise: Promise.resolve() };
  token.promise = (async () => {
    const bytes = await invoke<ArrayBuffer | number[]>("fonts_read", { id: font.id });
    const face = new FontFace(font.family, bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer, { weight: String(font.weight), style: font.style });
    await face.load();
    // Unregistered while loading: the face is never added.
    if (pending.get(font.id) !== token) return;
    document.fonts.add(face);
    registered.set(font.id, face);
    failed.delete(font.id);
  })().finally(() => { if (pending.get(font.id) === token) pending.delete(font.id); });
  pending.set(font.id, token);
  return token.promise;
}

function forget(id: string): void {
  const face = registered.get(id);
  if (face) document.fonts.delete(face);
  registered.delete(id);
  pending.delete(id);
  failed.delete(id);
}

/** Removes the face (also one still loading) and announces the change. */
export function unregisterImportedFont(id: string): void {
  forget(id);
  known = known.filter(font => font.id !== id);
  window.dispatchEvent(new Event(fontsChangedEvent));
}

/** Loads the face for a stored font list so measuring sees it; failure never blocks. */
export async function ensureFontLoaded(value: string): Promise<void> {
  const family = firstFontFamily(value);
  if (!family) return;
  try { await document.fonts.load(`14px "${family}"`); } catch { /* Fallback font stays in use. */ }
}
