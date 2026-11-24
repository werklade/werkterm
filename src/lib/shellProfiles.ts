import type { MenuItem } from "../components/MenuBar";
import { t } from "../i18n";
import type { ShellKind, ShellProfile } from "./pty";

const wslPrefix = "wsl:";
export const profileAction = "profile:";

export const profileKind = (id: string): ShellKind => id.startsWith(wslPrefix) ? "wsl" : "local";

/** Distribution name of a "wsl:<name>" profile id; null (default distribution) for anything else. */
export function wslDistroFromProfile(id: string | undefined): string | null {
  return id?.startsWith(wslPrefix) && id.length > wslPrefix.length ? id.slice(wslPrefix.length) : null;
}

/** Menu entry text; marks the default WSL distribution. */
export function profileMenuLabel(profile: ShellProfile): string {
  if (profile.kind === "wsl") return t(profile.isDefault ? "shell.wslDefault" : "shell.wsl", { name: profile.label });
  return profile.id === "cmd" ? t("shell.cmd") : profile.label;
}

/** Tab title; works without the profile list (restored tabs) by deriving it from the id. */
export function profileTitle(id: string, profiles: readonly ShellProfile[]): string {
  const known = profiles.find(profile => profile.id === id);
  const name = wslDistroFromProfile(id);
  if (name !== null) return t("shell.wsl", { name });
  if (id === "cmd") return t("shell.cmd");
  if (known) return known.label;
  return id === "powershell" ? "Windows PowerShell" : "PowerShell";
}

export interface ProfileGroups { powershell: ShellProfile[]; cmd: ShellProfile[]; wsl: ShellProfile[] }
/** Backend order is kept inside each group. */
export function groupProfiles(profiles: readonly ShellProfile[]): ProfileGroups {
  const groups: ProfileGroups = { powershell: [], cmd: [], wsl: [] };
  for (const profile of profiles) (profile.kind === "wsl" ? groups.wsl : profile.id === "cmd" ? groups.cmd : groups.powershell).push(profile);
  return groups;
}

/** Menu entries (action "profile:<id>"); a separator sits between the Windows shells and WSL. */
export function profileMenuItems(profiles: readonly ShellProfile[], separatorKey = "profiles"): MenuItem[] {
  const { powershell, cmd, wsl } = groupProfiles(profiles);
  const item = (profile: ShellProfile): MenuItem => ({ label: profileMenuLabel(profile), action: profileAction + profile.id });
  const local = [...powershell, ...cmd].map(item);
  return [...local, ...(local.length && wsl.length ? [{ label: "", action: `${separatorKey}-separator`, separator: true }] : []), ...wsl.map(item)];
}

/** Profile id from a menu action, or null. */
export const profileFromAction = (action: string): string | null => action.startsWith(profileAction) ? action.slice(profileAction.length) : null;
