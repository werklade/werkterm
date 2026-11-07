export interface Rgba { r: number; g: number; b: number; a: number }
export const EDITOR_BACKGROUND = "#1e1e1e";
const clamp = (n: number, maximum: number) => Math.max(0, Math.min(maximum, n));
const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)%?$/;
/** CSS numeric channels and alpha are clamped to their legal range; invalid syntax is ignored. */
export function parseColor(input: string): Rgba | null {
  const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(input);
  if (hex) {
    const value = hex[1].length < 5 ? [...hex[1]].map(c => c + c).join("") : hex[1];
    return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16), a: value.length === 8 ? parseInt(value.slice(6), 16) / 255 : 1 };
  }
  const functional = /^rgba?\(\s*([^()]*)\s*\)$/i.exec(input);
  if (!functional) return null;
  const body = functional[1].trim();
  const comma = body.includes(",");
  if (comma && body.includes("/")) return null;
  const parts = comma ? body.split(",").map(p => p.trim()) : body.split("/").flatMap((p, i) => i === 0 ? p.trim().split(/\s+/) : [p.trim()]);
  if (parts.length < 3 || parts.length > 4 || !parts.every(p => numeric.test(p))) return null;
  if (!comma && body.split("/").length > 2) return null;
  if (!comma && parts.length === 4 && !body.includes("/")) return null;
  const channel = (value: string) => clamp(value.endsWith("%") ? parseFloat(value) / 100 * 255 : parseFloat(value), 255);
  const alpha = parts[3] ?? "1";
  return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: clamp(parseFloat(alpha) / (alpha.endsWith("%") ? 100 : 1), 1) };
}
export function mixColor(color: Rgba, background: Rgba): Rgba {
  // Keep fractional channels until after contrast selection to respect the exact L=140 boundary.
  return { r: color.r * color.a + background.r * (1 - color.a), g: color.g * color.a + background.g * (1 - color.a), b: color.b * color.a + background.b * (1 - color.a), a: 1 };
}
export function luminance(color: Pick<Rgba, "r" | "g" | "b">): number {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}
export function textColor(color: Pick<Rgba, "r" | "g" | "b">): "#000000" | "#ffffff" {
  return luminance(color) > 140 ? "#000000" : "#ffffff";
}
export function colorCodeMatches(text: string): { from: number; to: number; color: Rgba }[] {
  const result: { from: number; to: number; color: Rgba }[] = [];
  const pattern = /#[\da-f]+|\brgba?\([^()\r\n]*\)/gi;
  for (const match of text.matchAll(pattern)) {
    const from = match.index;
    const to = from + match[0].length;
    if (/[\w#-]/.test(text[from - 1] ?? "") || /[\w-]/.test(text[to] ?? "")) continue;
    const color = parseColor(match[0]);
    if (color) result.push({ from, to, color });
  }
  return result;
}
