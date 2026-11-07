export interface QuickConnectTarget {
  user: string | null;
  host: string;
  port: number;
}

export function parseQuickConnect(input: string): QuickConnectTarget | null {
  const match = /^(?:([^\s@]+)@)?(?:\[([0-9a-fA-F:.]+)\]|([a-zA-Z0-9.-]+))(?::([0-9]+))?$/.exec(input.trim());
  if (!match) return null;
  const [, user, ipv6, hostname, portText] = match;
  if (user && /[:/\\]/.test(user)) return null;
  const port = portText === undefined ? 22 : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (ipv6) {
    try { new URL(`http://[${ipv6}]/`); } catch { return null; }
  } else {
    const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    if (host.length > 253 || host.split('.').some(label => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) return null;
    if (/^[0-9.]+$/.test(host) && (host.split('.').length !== 4 || host.split('.').some(part => Number(part) > 255))) return null;
  }
  return { user: user ?? null, host: ipv6 ?? hostname, port };
}
