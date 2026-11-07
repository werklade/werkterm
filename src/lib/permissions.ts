import { invoke } from "@tauri-apps/api/core";

export function parseOctal(value: string): number | null {
  return /^[0-7]{3,4}$/.test(value) ? Number.parseInt(value, 8) : null;
}
export function octal(mode: number): string { return mode.toString(8).padStart(3, "0"); }
export function modeToRwx(mode: number): string {
  return [6, 3, 0].map((shift, group) => {
    const special = (mode & [0o4000, 0o2000, 0o1000][group]) !== 0;
    const execute = (mode & (1 << shift)) !== 0;
    return ((mode & (4 << shift)) ? "r" : "-") + ((mode & (2 << shift)) ? "w" : "-")
      + (special ? (group === 2 ? (execute ? "t" : "T") : (execute ? "s" : "S")) : (execute ? "x" : "-"));
  }).join("");
}
export function rwxToMode(value: string): number | null {
  if (!/^[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]$/.test(value)) return null;
  let mode = 0;
  for (let group = 0; group < 3; group++) {
    const shift = (2 - group) * 3, part = value.slice(group * 3, group * 3 + 3);
    if (part[0] === "r") mode |= 4 << shift;
    if (part[1] === "w") mode |= 2 << shift;
    if (/[xst]/.test(part[2])) mode |= 1 << shift;
    if (/[sStT]/.test(part[2])) mode |= [0o4000, 0o2000, 0o1000][group];
  }
  return mode;
}
export const togglePermission = (mode: number, bit: number, checked: boolean) => checked ? mode | bit : mode & ~bit;
export interface PermissionFields { value: string; recursive: boolean; split: boolean; directories: string; files: string }
export interface ChmodOptions { mode: number; recursive: boolean; scope: "all" | "dirs" | "files"; dirMode: number | null; fileMode: number | null }
export function chmodOptions(fields: PermissionFields): ChmodOptions | null {
  const mode = parseOctal(fields.value), separate = fields.recursive && fields.split;
  const dirMode = separate ? parseOctal(fields.directories) : null;
  const fileMode = separate ? parseOctal(fields.files) : null;
  if (mode === null || (separate && (dirMode === null || fileMode === null))) return null;
  return { mode, recursive: fields.recursive, scope: "all", dirMode, fileMode };
}
export interface ChmodResult { changed: number; failed: number; errors: string[] }
export const chmod = (id: number, path: string, options: ChmodOptions) => invoke<ChmodResult>("ssh_chmod", { id, path, ...options });
export const enableSudo = (id: number, password: string | null = null) => invoke<void>("ssh_sudo_enable", { id, password });
export const disableSudo = (id: number) => invoke<void>("ssh_sudo_disable", { id });
