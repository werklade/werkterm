import { Channel, invoke } from "@tauri-apps/api/core";

export type ShellKind = "local" | "wsl";
export type StartCommand = "root" | "processes" | "hardware";
/** One selectable local shell. `id`: "pwsh:<path>", "powershell", "cmd" or "wsl:<name>". */
export interface ShellProfile { id: string; kind: ShellKind; label: string; version: string | null; isDefault: boolean }
export interface SpawnOptions {
  /** Shell profile id; without it the default shell of the kind starts. */
  profile?: string;
  serialPermissionShell?: boolean;
  startCommand?: StartCommand;
  kind: ShellKind;
  tabId: number;
  cols: number;
  rows: number;
  shellIntegration: boolean;
  onData: Channel<ArrayBuffer>;
  onExit: Channel<number | null>;
}
export { Channel };
export const availableShells = () => invoke<ShellKind[]>("available_shells");
export const availableShellProfiles = () => invoke<ShellProfile[]>("available_shell_profiles");
export const spawnPty = (options: SpawnOptions) => invoke<number>("pty_spawn", { ...options });
export const writePty = (id: number, data: string) => invoke<void>("pty_write", { id, data });
export const resizePty = (id: number, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows });
export const killPty = (id: number) => invoke<void>("pty_kill", { id });
