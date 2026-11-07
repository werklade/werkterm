import type { IBuffer, IBufferCell, ITheme } from "@xterm/xterm";
import { ansiKeys } from "./terminalThemes";

export interface RunStyle { fg: string; bg: string; bold: boolean; italic: boolean; underline: boolean; dim: boolean }
export interface TextRun { text: string; style: RunStyle }
export interface TerminalDocument { lines: TextRun[][]; foreground: string; background: string; fontFamily: string }
const hex = (n: number) => n.toString(16).padStart(2, "0");
export function paletteColor(index: number, theme: ITheme = {}): string {
  if (index < 16) return theme[ansiKeys[index]] ?? ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"][index];
  if (index >= 232) { const v = hex(8 + (index - 232) * 10); return `#${v}${v}${v}`; }
  const n = index - 16, levels = [0, 95, 135, 175, 215, 255];
  return `#${hex(levels[Math.floor(n / 36)])}${hex(levels[Math.floor(n / 6) % 6])}${hex(levels[n % 6])}`;
}
export function cellStyle(cell: IBufferCell, theme: ITheme): RunStyle {
  const color = (fg: boolean) => {
    const value = fg ? cell.getFgColor() : cell.getBgColor();
    if (fg ? cell.isFgDefault() : cell.isBgDefault()) return (fg ? theme.foreground : theme.background) ?? (fg ? "#ffffff" : "#000000");
    if (fg ? cell.isFgPalette() : cell.isBgPalette()) return paletteColor(value, theme);
    if (fg ? cell.isFgRGB() : cell.isBgRGB()) return `#${value.toString(16).padStart(6, "0")}`;
    return (fg ? theme.foreground : theme.background) ?? (fg ? "#ffffff" : "#000000");
  };
  let fg = color(true), bg = color(false);
  if (cell.isInverse()) [fg, bg] = [bg, fg];
  return { fg, bg, bold: !!cell.isBold(), italic: !!cell.isItalic(), underline: !!cell.isUnderline(), dim: !!cell.isDim() };
}
export function appendRun(line: TextRun[], text: string, style: RunStyle): void {
  const last = line[line.length - 1];
  if (last && Object.keys(style).every(key => last.style[key as keyof RunStyle] === style[key as keyof RunStyle])) last.text += text;
  else line.push({ text, style });
}
export function readTerminal(buffer: IBuffer, theme: ITheme = {}, fontFamily = "monospace"): TerminalDocument {
  const lines: TextRun[][] = [];
  for (let y = 0; y < buffer.length; y++) {
    const source = buffer.getLine(y);
    if (!source) continue;
    const line = source.isWrapped && lines.length ? lines[lines.length - 1] : [];
    if (!source.isWrapped || !lines.length) lines.push(line);
    // Only trim the end of a logical line: wrapped rows retain their spaces.
    const end = buffer.getLine(y + 1)?.isWrapped ? source.length : source.translateToString(true).length;
    let units = 0;
    for (let x = 0; x < source.length && units < end; x++) {
      const cell = source.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const text = cell.getChars() || " ";
      appendRun(line, text, cellStyle(cell, theme));
      units += text.length;
    }
  }
  while (lines.length && !lines[lines.length - 1].some(run => run.text.trim())) lines.pop();
  return { lines, foreground: theme.foreground ?? "#ffffff", background: theme.background ?? "#000000", fontFamily };
}
export function exportText(doc: TerminalDocument, windows = false): string {
  return doc.lines.map(line => line.map(run => run.text).join("")).join(windows ? "\r\n" : "\n");
}
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
// Quote each family as a CSS string so font settings cannot introduce CSS resources.
function cssFontFamily(value: string): string {
  return value.split(",").map(family => {
    const name = family.trim().replace(/^["']|["']$/g, "");
    return `"${name.replace(/[\\"\r\n]/g, char => `\\${char.charCodeAt(0).toString(16)} `)}"`;
  }).join(",") + ",monospace";
}
export function exportHtml(doc: TerminalDocument, title: string): string {
  const lines = doc.lines.map(line => line.map(({ text, style: s }) => `<span style="color:${escapeHtml(s.fg)};background-color:${escapeHtml(s.bg)};font-weight:${s.bold ? "bold" : "normal"};font-style:${s.italic ? "italic" : "normal"};text-decoration:${s.underline ? "underline" : "none"};opacity:${s.dim ? "0.5" : "1"}">${escapeHtml(text)}</span>`).join("")).join("\n");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="background-color:${escapeHtml(doc.background)};color:${escapeHtml(doc.foreground)}"><pre style="font-family:${escapeHtml(cssFontFamily(doc.fontFamily))}">${lines}</pre></body></html>`;
}
export function escapeRtf(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i), char = value[i];
    if ("\\{}".includes(char)) result += `\\${char}`;
    else if (code > 127) result += `\\u${code > 32767 ? code - 65536 : code}?`;
    else if (char === "\t") result += "\\tab ";
    else if (char === "\n") result += "\\line ";
    else if (code >= 32) result += char;
  }
  return result;
}
export function exportRtf(doc: TerminalDocument): string {
  const colors: string[] = [];
  const color = (value: string) => { if (!colors.includes(value)) colors.push(value); return colors.indexOf(value) + 1; };
  const dimColor = (s: RunStyle) => s.dim ? `#${[1, 3, 5].map(i => hex(Math.round((parseInt(s.fg.slice(i, i + 2), 16) + parseInt(s.bg.slice(i, i + 2), 16)) / 2))).join("")}` : s.fg;
  const body = doc.lines.map(line => line.map(({ text, style: s }) => `\\cf${color(dimColor(s))}\\highlight${color(s.bg)}\\b${s.bold ? 1 : 0}\\i${s.italic ? 1 : 0}\\ul${s.underline ? 1 : 0} ${escapeRtf(text)}`).join("")).join("\\line\n");
  const table = colors.map(c => `\\red${parseInt(c.slice(1, 3), 16)}\\green${parseInt(c.slice(3, 5), 16)}\\blue${parseInt(c.slice(5, 7), 16)};`).join("");
  const font = doc.fontFamily.split(",")[0].replace(/["';]/g, "").trim() || "monospace";
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 ${escapeRtf(font)};}}{\\colortbl;${table}}\\f0\\uc1 ${body}}`;
}
