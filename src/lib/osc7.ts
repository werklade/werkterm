export interface TerminalCwd { host: string; path: string }

/** Parse the OSC 7 payload without URL normalization of remote paths or hosts. */
export function parseOsc7(value: string): TerminalCwd | null {
  const match = /^file:\/\/([^/\s?#]*)\/(.*)$/s.exec(value);
  if (!match || /[\x00-\x1f\x7f]/.test(value)) return null;
  let path = `/${match[2]}`;
  try { path = decodeURIComponent(path); } catch { /* Keep malformed encodings verbatim. */ }
  if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
  return { host: match[1], path };
}
