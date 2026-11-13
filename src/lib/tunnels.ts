import { currentLocale, t } from "../i18n";
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
export function validateTunnel(tunnel: Tunnel, sessions: SavedSession[]): string {
  const host = (value: string) => value.length > 0 && !/[\s\x00-\x1f\x7f-\x9f]/.test(value);
  const port = (value: number | null, zero = false) => value !== null && Number.isInteger(value) && value >= (zero ? 0 : 1) && value <= 65535;
  if (!tunnel.name.trim()) return t("tunnel.validate.name");
  if (!sessions.some(s => s.id === tunnel.session_id && s.kind === "ssh")) return t("tunnel.validate.session");
  if (!host(tunnel.bind_address) || !port(tunnel.bind_port, tunnel.kind === "remote")) return t("tunnel.validate.bind");
  if (tunnel.kind !== "remote" && !isBindAddress(tunnel.bind_address)) return t("tunnel.validate.localBind");
  if (tunnel.kind !== "dynamic" && (!host(tunnel.target_host) || !port(tunnel.target_port))) return t("tunnel.validate.target");
  if (tunnel.kind === "dynamic" && (tunnel.target_host !== "" || tunnel.target_port !== null)) return t("tunnel.validate.dynamic");
  if (!isLoopback(tunnel.bind_address) && !tunnel.allow_public) return t("tunnel.validate.public");
  return "";
}
export function statusText(s?: TunnelStatus): string {
  if (!s) return t("tunnel.state.stopped");
  return t(`tunnel.state.${s.state}`) + (s.error ? `: ${s.error}` : "");
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const oneDecimal = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toLocaleString(currentLocale(), oneDecimal)} KiB`;
  return `${(bytes / 1024 ** 2).toLocaleString(currentLocale(), oneDecimal)} MiB`;
}
export function sessionRoute(id: string, sessions: SavedSession[]): string {
  const route: string[] = []; const seen = new Set<string>();
  let session = sessions.find(s => s.id === id);
  while (session && !seen.has(session.id)) { seen.add(session.id); route.push(session.name); session = sessions.find(s => s.id === session?.jumpSessionId); }
  const name = route[0] ?? t("tunnel.sessionMissing");
  return route.length > 1 ? t("tunnel.route", { name, route: route.slice(1).reverse().join(" → ") }) : name;
}
