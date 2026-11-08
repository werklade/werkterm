import { invoke } from "@tauri-apps/api/core";
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
export interface StoredIconSet { id: string; name: string; icons: string[] }
