import { parseBackendError } from "./backendError";
export interface SerialPermission {
  device: string; group: string; username: string; guessed: boolean;
  already_member: boolean; os_id: string; os_id_like: string;
}
export interface FixOption { label: string; command: string; needs_root_password: boolean }
/** install_hint is a command line, or empty when the distribution is unknown (the dialog shows a general hint). */
export interface FixOptions { options: FixOption[]; missing: string[]; install_hint: string; root_command: string }
const flag = (value: string | undefined) => value === "true" ? true : value === "false" ? false : undefined;
/** SERIAL_PERMISSION carries the dialog data as string args; without them (Windows) it is an ordinary error. */
export function parseSerialPermission(error: unknown): SerialPermission | null {
  const parsed = parseBackendError(error);
  if (parsed?.code !== "SERIAL_PERMISSION") return null;
  const { device, group, username, os_id, os_id_like } = parsed.args;
  const guessed = flag(parsed.args.guessed), already_member = flag(parsed.args.already_member);
  if ([device, group, username, os_id, os_id_like].some(value => value === undefined) || guessed === undefined || already_member === undefined) return null;
  return { device, group, username, guessed, already_member, os_id, os_id_like };
}
export const permissionMode = (info: SerialPermission, fixes: FixOptions | null) =>
  info.already_member ? "member" : fixes === null ? "loading" : fixes.options.length ? "options" : "missing";
// Only the newly created local tab may consume this one-shot command.
export const serialFixCommands = new Map<number, { command: string; resolve(): void; reject(error: unknown): void }>();
