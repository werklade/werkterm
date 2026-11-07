import type { SerialConfig } from "./sessions";
import { parseQuickConnect } from "./quickConnect";
export function connectionTitle(kind: string, target: string, config?: SerialConfig | null, name?: string): string {
  if (name) return name;
  if (kind === "serial") return `${config?.device ?? ""}@${config?.baud ?? 115200}`;
  const parsed = parseQuickConnect(target);
  if (!parsed) return target;
  return kind === "telnet" ? `${parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host}:${parsed.port}` : `${parsed.user ?? ""}@${parsed.host}`;
}
export function connectionStatus(kind: string, config?: SerialConfig | null): string {
  if (kind === "telnet") return "Telnet – unverschlüsselt";
  if (kind !== "serial" || !config) return "";
  return `${config.device} ${config.baud} ${config.data_bits}${({ none: "N", odd: "O", even: "E" })[config.parity]}${config.stop_bits}`;
}
