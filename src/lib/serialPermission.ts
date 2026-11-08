export interface SerialPermission {
  device: string; group: string; username: string; guessed: boolean;
  already_member: boolean; os_id: string; os_id_like: string;
}
export interface FixOption { label: string; command: string; needs_root_password: boolean; hint: string }
export interface FixOptions { options: FixOption[]; missing: string[]; install_hint: string; root_command: string }
export function parseSerialPermission(error: unknown): SerialPermission | null {
  const text = String(error);
  if (!text.startsWith("SERIAL_PERMISSION:")) return null;
  try {
    const value = JSON.parse(text.slice("SERIAL_PERMISSION:".length));
    if (["device", "group", "username", "os_id", "os_id_like"].every(key => typeof value?.[key] === "string")
      && typeof value.guessed === "boolean" && typeof value.already_member === "boolean") return value;
  } catch { /* Ordinary errors remain terminal errors. */ }
  return null;
}
export const permissionMode = (info: SerialPermission, fixes: FixOptions | null) =>
  info.already_member ? "member" : fixes === null ? "loading" : fixes.options.length ? "options" : "missing";
// Only the newly created local tab may consume this one-shot command.
export const serialFixCommands = new Map<number, { command: string; resolve(): void; reject(error: unknown): void }>();
