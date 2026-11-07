import type { SavedSession } from "./sessions";
export interface Tunnel { id: string; name: string; kind: "local" | "remote" | "dynamic"; session_id: string; bind_address: string; bind_port: number; target_host: string; target_port: number | null; autostart: boolean; reconnect: boolean; allow_public: boolean }
export interface TunnelStatus { id: string; state: "stopped" | "connecting" | "running" | "error" | "reconnecting"; error: string | null; connections: number; bytes_in: number; bytes_out: number; bound_port: number | null }
function ipv4Parts(host: string): string[] | null {
  const parts = host.split(".");
  return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255 && String(Number(p)) === p) ? parts : null;
}
function ipv6Host(host: string): string | null {
  if (!host.includes(":") || !/^[0-9a-fA-F:.]+$/.test(host)) return null;
  try { return new URL(`http://[${host}]/`).hostname; } catch { return null; }
}
export function isLoopback(host: string): boolean {
  return /^localhost$/i.test(host) || ipv4Parts(host)?.[0] === "127" || ipv6Host(host) === "[::1]";
}
export function isBindAddress(host: string): boolean {
  return /^localhost$/i.test(host) || ipv4Parts(host) !== null || ipv6Host(host) !== null;
}
export function validateTunnel(t: Tunnel, sessions: SavedSession[]): string {
  const host = (value: string) => value.length > 0 && !/[\s\x00-\x1f\x7f-\x9f]/.test(value);
  const port = (value: number | null, zero = false) => value !== null && Number.isInteger(value) && value >= (zero ? 0 : 1) && value <= 65535;
  if (!t.name.trim()) return "Name fehlt.";
  if (!sessions.some(s => s.id === t.session_id && s.kind === "ssh")) return "SSH-Sitzung wählen.";
  if (!host(t.bind_address) || !port(t.bind_port, t.kind === "remote")) return "Bind-Adresse oder Port ist ungültig.";
  if (t.kind !== "remote" && !isBindAddress(t.bind_address)) return "Lokale Bind-Adresse muss eine IP-Adresse oder localhost sein.";
  if (t.kind !== "dynamic" && (!host(t.target_host) || !port(t.target_port))) return "Ziel-Host oder Port ist ungültig.";
  if (t.kind === "dynamic" && (t.target_host !== "" || t.target_port !== null)) return "Dynamische Tunnel haben kein festes Ziel.";
  if (!isLoopback(t.bind_address) && !t.allow_public) return "Öffentliche Bind-Adresse muss bestätigt werden.";
  return "";
}
export function statusText(s?: TunnelStatus): string {
  if (!s) return "Gestoppt";
  return ({ stopped: "Gestoppt", connecting: "Verbinde…", running: "Aktiv", reconnecting: "Verbinde erneut…", error: "Fehler" }[s.state]) + (s.error ? `: ${s.error}` : "");
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
export function sessionRoute(id: string, sessions: SavedSession[]): string {
  const route: string[] = []; const seen = new Set<string>();
  let session = sessions.find(s => s.id === id);
  while (session && !seen.has(session.id)) { seen.add(session.id); route.push(session.name); session = sessions.find(s => s.id === session?.jumpSessionId); }
  return (route[0] ?? "Sitzung fehlt") + (route.length > 1 ? ` über ${route.slice(1).reverse().join(" → ")}` : "");
}
