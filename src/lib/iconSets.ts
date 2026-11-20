import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
export interface IconSnapshot { name: string; overrides: Readonly<Record<string, string>> }
let snapshot: IconSnapshot = { name: "Standard", overrides: {} };
const listeners = new Set<() => void>();
let request = 0;
export function subscribeIcons(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getIconSnapshot() { return snapshot; }
export function iconSvg(set: IconSnapshot, name: string, standard: Record<string, string>): string {
  return Object.prototype.hasOwnProperty.call(set.overrides, name) ? set.overrides[name] : standard[name];
}
export function setIconSet(name: string, overrides: Record<string, string> = {}) {
  snapshot = { name, overrides: { ...overrides } };
  if (typeof document !== "undefined") document.documentElement.dataset.icons = name === "Werklade" ? "werklade" : "standard";
  for (const listener of listeners) listener();
}
export async function activateIconSet(name: string) {
  const current = ++request;
  if (name === "Standard" || name === "Werklade") { setIconSet(name); return; }
  setIconSet("Standard");
  const overrides = await invoke<Record<string, string>>("icon_sets_load", { id: name });
  if (current === request) setIconSet(name, overrides);
}
/**
 * Reloads the active imported set after an external change of icon-sets/. Unlike activateIconSet the current icons
 * stay visible while loading. Returns true if the icons changed. A set that can no longer be loaded falls back to
 * Standard and the error is passed on, as with activateIconSet.
 */
export async function reloadIconSet(name: string): Promise<boolean> {
  if (name === "Standard" || name === "Werklade") return false;
  const current = ++request;
  let overrides: Record<string, string>;
  try { overrides = await invoke<Record<string, string>>("icon_sets_load", { id: name }); }
  catch (reason) {
    if (current === request && snapshot.name !== "Standard") setIconSet("Standard");
    throw reason;
  }
  if (current !== request) return false;
  const same = snapshot.name === name && JSON.stringify(sorted(snapshot.overrides)) === JSON.stringify(sorted(overrides));
  if (!same) setIconSet(name, overrides);
  return !same;
}
const sorted = (map: Readonly<Record<string, string>>) => Object.keys(map).sort().map(key => [key, map[key]]);
/** Display name of a built-in icon set id; "Standard" is the persisted id of the default set. */
export const iconSetLabel = (id: string): string => id === "Standard" ? t("iconSet.standard") : id;
export interface StoredIconSet { id: string; name: string; icons: string[] }
