export const decimal = (n: number, digits = 0) => n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export function size(n: number) { const units = ["B", "kB", "MB", "GB", "TB"]; let i = 0; while (n >= 1000 && i < 4) { n /= 1000; i++; } return `${decimal(n, i ? 1 : 0)} ${units[i]}`; }
export const rate = (n: number | null) => n === null ? "–" : `${size(n)}/s`;
export function uptime(n: number, full = false) { const d = Math.floor(n / 86400), h = Math.floor(n / 3600) % 24, m = Math.floor(n / 60) % 60; return full ? `${d} ${d === 1 ? "Tag" : "Tage"}, ${h} h, ${m} min (${n} Sekunden)` : d ? `${d} ${d === 1 ? "Tag" : "Tage"}` : h ? `${h} h` : `${m} min`; }
export function users(lines: string[]) {
  const counts = new Map<string, number>();
  for (const name of lines.map(l => l.trim().split(/\s+/)[0]).filter(Boolean)) counts.set(name, (counts.get(name) ?? 0) + 1);
  const names = [...counts].map(([name, n]) => n > 1 ? `${name} (x${n})` : name);
  return names.length ? `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}` : "–";
}
/** Bar order: system mounts first, then user mounts (/mnt, /media, /srv), then the rest. */
const diskRank = (mount: string) => {
  const fixed = ["/", "/boot", "/boot/efi", "/home", "/var", "/tmp"].indexOf(mount);
  return fixed >= 0 ? fixed : /^\/(mnt|media|srv)(\/|$)/.test(mount) ? 10 : 20;
};
export function orderDisks<T extends { mount: string }>(disks: T[]): T[] {
  return [...disks].sort((a, b) => diskRank(a.mount) - diskRank(b.mount) || a.mount.localeCompare(b.mount));
}
/** How many fields fit into `available` pixels, keeping room for a "+N" field when some are hidden. */
export function fittingCount(widths: number[], available: number, more = 44): number {
  let used = 0;
  for (let i = 0; i < widths.length; i++) {
    const reserve = i < widths.length - 1 ? more : 0;
    if (used + widths[i] + reserve > available) return i;
    used += widths[i];
  }
  return widths.length;
}
/** Letter badges (no logos) for distributions; only Debian has an allowed open-use logo. */
export const distroBadges: Record<string, [letter: string, color: string]> = {
  debian: ["D", "#a80030"], ubuntu: ["U", "#e95420"], alpine: ["A", "#0d597f"], fedora: ["F", "#51a2da"], arch: ["A", "#1793d1"],
  centos: ["C", "#932279"], rocky: ["R", "#10b981"], almalinux: ["A", "#0f4266"], opensuse: ["S", "#73ba25"], linuxmint: ["M", "#87cf3e"],
  raspbian: ["R", "#c51a4a"], gentoo: ["G", "#54487a"], kali: ["K", "#367bf0"], manjaro: ["M", "#35bf5c"], nixos: ["N", "#5277c3"],
  rhel: ["R", "#cc0000"], amzn: ["A", "#ff9900"], pop: ["P", "#48b9c7"], void: ["V", "#478061"], slackware: ["S", "#4d4d8f"],
};
const aliases: Record<string, string> = { "opensuse-leap": "opensuse", "opensuse-tumbleweed": "opensuse", sles: "opensuse", suse: "opensuse", archarm: "arch", endeavouros: "arch", ol: "rhel" };
/** Distribution key from os-release ID, falling back to ID_LIKE (e.g. Pop!_OS -> pop, unknown Ubuntu flavour -> ubuntu); "tux" when unknown. */
export function distro(id: string | null, idLike: string | null = null): string {
  for (const candidate of [id ?? "", ...(idLike ?? "").split(/\s+/)]) {
    const key = aliases[candidate.toLowerCase()] ?? candidate.toLowerCase();
    if (key in distroBadges) return key;
  }
  return "tux";
}
export const history = (values: number[], n: number) => [...values, Math.max(0, Math.min(100, n))].slice(-60);
export interface Disk { device: string; mount: string; usedPercent: number; sizeBytes: number; usedBytes: number; freeBytes: number }
export function dfTable(disks: Disk[]) { const rows = [["Dateisystem", "Größe", "Belegt", "Frei", "Belegt%", "Eingehängt auf"], ...disks.map(d => [d.device, size(d.sizeBytes), size(d.usedBytes), size(d.freeBytes), `${d.usedPercent}%`, d.mount])]; const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length))); return rows.map(r => r.map((v, i) => i > 0 && i < 5 ? v.padStart(widths[i]) : v.padEnd(widths[i])).join("  ").trimEnd()).join("\n"); }
