export interface TerminalCwd { host: string; path: string }

/** Decode once without URL normalization; Windows paths belong only to local tabs. */
export function parseOsc7(value: string, localWindows = false): TerminalCwd | null {
  const match = /^file:\/\/([^/\s?#]*)\/(.*)$/s.exec(value);
  if (!match || /[\x00-\x1f\x7f]/.test(value)) return null;
  let path = `/${match[2]}`;
  try { path = decodeURIComponent(path); } catch { /* Keep malformed encodings verbatim. */ }
  if (localWindows) {
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    else if (!path.startsWith("//") && match[1] && match[1].toLowerCase() !== "localhost") path = `//${match[1]}${path}`;
  }
  return { host: match[1], path };
}
