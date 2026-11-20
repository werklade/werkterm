/** Frontend mirror of the syntax checks in src-tauri/src/ssh/options.rs.
 * Algorithm names are validated by the backend (save, import, connect). */
export const MAX_SSH_OPTION_LINES = 32;
export const MAX_SSH_OPTIONS_LENGTH = 4096;

const keys = ["kexalgorithms", "hostkeyalgorithms", "pubkeyacceptedalgorithms", "pubkeyacceptedkeytypes",
  "ciphers", "macs", "connecttimeout", "serveraliveinterval", "serveralivecountmax"];
const listKeys = new Set(["kexalgorithms", "hostkeyalgorithms", "pubkeyacceptedalgorithms", "ciphers", "macs"]);
const weak = new Set(["diffie-hellman-group1-sha1", "diffie-hellman-group14-sha1", "diffie-hellman-group-exchange-sha1",
  "ssh-rsa", "aes128-cbc", "aes192-cbc", "aes256-cbc", "3des-cbc", "hmac-sha1", "hmac-sha1-etm@openssh.com"]);

export type SshOptionProblem =
  | { kind: "tooLong" }
  | { kind: "malformed"; line: number }
  | { kind: "unknown"; line: number; key: string }
  | { kind: "duplicate"; line: number; key: string };

interface SshOption { line: number; key: string; value: string }

/** Byte length like the backend (Rust `str::len`), not UTF-16 code units. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function splitLine(text: string): { key: string; value: string } | null {
  const line = text.startsWith("-o") ? text.slice(2).trimStart() : text;
  const match = /^([A-Za-z0-9]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (!match) return null;
  const raw = match[2].trim();
  const value = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return { key: match[1], value };
}

function readOptions(text: string): { options: SshOption[]; problem: SshOptionProblem | null } {
  const lines = text.split(/\r?\n/);
  const options: SshOption[] = [];
  if (utf8Length(text) > MAX_SSH_OPTIONS_LENGTH || lines.filter(line => line.trim()).length > MAX_SSH_OPTION_LINES) return { options, problem: { kind: "tooLong" } };
  const seen = new Set<string>();
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = splitLine(trimmed);
    if (!parts) return { options, problem: { kind: "malformed", line } };
    let key = parts.key.toLowerCase();
    if (!keys.includes(key)) return { options, problem: { kind: "unknown", line, key: parts.key } };
    if (key === "pubkeyacceptedkeytypes") key = "pubkeyacceptedalgorithms";
    if (!parts.value || /[\s\p{Cc}"]/u.test(parts.value)) return { options, problem: { kind: "malformed", line } };
    if (seen.has(key)) return { options, problem: { kind: "duplicate", line, key: parts.key } };
    seen.add(key);
    options.push({ line, key, value: parts.value });
  }
  return { options, problem: null };
}

/** First syntax problem (line numbers are 1-based), or null. */
export function checkSshOptions(text: string): SshOptionProblem | null {
  return readOptions(text).problem;
}

/** Weak algorithms the text explicitly opts into (removals with `-` do not count). */
export function legacySshAlgorithms(text: string): string[] {
  const found: string[] = [];
  for (const option of readOptions(text).options) {
    if (!listKeys.has(option.key) || option.value.startsWith("-")) continue;
    for (const name of option.value.replace(/^[+^]/, "").split(",")) {
      const lower = name.trim().toLowerCase();
      if (weak.has(lower) && !found.includes(lower)) found.push(lower);
    }
  }
  return found;
}

/** Whether the text sets ServerAliveInterval/ServerAliveCountMax (overrides the keepalive fields). */
export function sshOptionsOverrideKeepalive(text: string): boolean {
  return readOptions(text).options.some(option => option.key === "serveraliveinterval" || option.key === "serveralivecountmax");
}

/** Accepts a single quick connect option (`Key=Value`, as after `-o`). */
export function isQuickConnectOption(option: string): boolean {
  return /^[A-Za-z0-9]+=\S+$/.test(option) && checkSshOptions(option) === null;
}
