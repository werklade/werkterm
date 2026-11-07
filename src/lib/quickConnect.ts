export interface QuickConnectTarget {
  kind?: "ssh" | "telnet" | "serial";
  baud?: number;
  user: string | null;
  host: string;
  port: number;
}

export function parseQuickConnect(input: string): QuickConnectTarget | null {
  if (input.trim().startsWith("serial://")) {
    const match = /^serial:\/\/([^\s@]+)(?:@(\d+))?$/.exec(input.trim());
    const baud = Number(match?.[2] ?? 115200);
    return match && Number.isInteger(baud) && baud > 0 && baud <= 4294967295 ? { kind: "serial", host: match[1], port: 0, user: null, baud } : null;
  }
  const telnet = input.trim().startsWith("telnet://");
  if (telnet) input = input.trim().slice(9);
  const match = /^(?:([^\s@]+)@)?(?:\[([0-9a-fA-F:.]+)\]|([a-zA-Z0-9.-]+))(?::([0-9]+))?$/.exec(input.trim());
  if (!match) return null;
  const [, user, ipv6, hostname, portText] = match;
  if (user && /[:/\\]/.test(user)) return null;
  const port = portText === undefined ? (telnet ? 23 : 22) : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (ipv6) {
    try { new URL(`http://[${ipv6}]/`); } catch { return null; }
  } else {
    const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    if (host.length > 253 || host.split('.').some(label => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) return null;
    if (/^[0-9.]+$/.test(host) && (host.split('.').length !== 4 || host.split('.').some(part => Number(part) > 255))) return null;
  }
  if (telnet && user) return null;
  return { ...(telnet ? { kind: "telnet" as const } : {}), user: user ?? null, host: ipv6 ?? hostname, port };
}
