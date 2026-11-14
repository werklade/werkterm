import { errorText } from "./backendError";

/**
 * Telnet and serial send error notices as `{ notice: "<wire-format error>" }` on the same data
 * channel as the raw output (so ordering is kept). Returns the translated line for xterm, or null
 * for ordinary output bytes.
 */
export function terminalNotice(message: unknown): string | null {
  if (message instanceof ArrayBuffer || typeof message !== "object" || message === null) return null;
  const notice = (message as { notice?: unknown }).notice;
  if (typeof notice !== "string") return null;
  return `\r\n[${errorText(notice).replace(/[\x00-\x1f\x7f]/g, " ")}]\r\n`;
}
