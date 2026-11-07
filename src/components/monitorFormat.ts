export const decimal = (n: number, digits = 0) => n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export function size(n: number) { const units = ["B", "kB", "MB", "GB", "TB"]; let i = 0; while (n >= 1000 && i < 4) { n /= 1000; i++; } return `${decimal(n, i ? 1 : 0)} ${units[i]}`; }
export const rate = (n: number | null) => n === null ? "–" : `${size(n)}/s`;
export function uptime(n: number, full = false) { const d = Math.floor(n / 86400), h = Math.floor(n / 3600) % 24, m = Math.floor(n / 60) % 60; return full ? `${d} ${d === 1 ? "Tag" : "Tage"}, ${h} h, ${m} min (${n} Sekunden)` : d ? `${d} ${d === 1 ? "Tag" : "Tage"}` : h ? `${h} h` : `${m} min`; }
export function users(lines: string[]) { const names = [...new Set(lines.map(l => l.trim().split(/\s+/)[0]).filter(Boolean))]; return names.length ? `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}` : "–"; }
export const distro = (id: string | null) => ["debian", "ubuntu", "alpine"].includes(id ?? "") ? id! : "tux";
export const history = (values: number[], n: number) => [...values, Math.max(0, Math.min(100, n))].slice(-60);
export interface Disk { device: string; mount: string; usedPercent: number; sizeBytes: number; usedBytes: number; freeBytes: number }
export function dfTable(disks: Disk[]) { const rows = [["Dateisystem", "Größe", "Belegt", "Frei", "Belegt%", "Eingehängt auf"], ...disks.map(d => [d.device, size(d.sizeBytes), size(d.usedBytes), size(d.freeBytes), `${d.usedPercent}%`, d.mount])]; const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length))); return rows.map(r => r.map((v, i) => i > 0 && i < 5 ? v.padStart(widths[i]) : v.padEnd(widths[i])).join("  ").trimEnd()).join("\n"); }
