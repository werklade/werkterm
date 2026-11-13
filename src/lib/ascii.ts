import { t, type TextKey } from "../i18n";
export interface AsciiRow { decimal: number; hex: string; octal: string; character: string; name: string }
/** Control characters: [code, optional C escape]. Descriptions come from the `ascii.<code>` keys. */
const controls: [string, string?][] = [
  ["NUL", "\\0"], ["SOH"], ["STX"], ["ETX"], ["EOT"], ["ENQ"], ["ACK"], ["BEL", "\\a"],
  ["BS", "\\b"], ["HT", "\\t"], ["LF", "\\n"], ["VT", "\\v"], ["FF", "\\f"], ["CR", "\\r"],
  ["SO"], ["SI"], ["DLE"], ["DC1"], ["DC2"], ["DC3"], ["DC4"],
  ["NAK"], ["SYN"], ["ETB"], ["CAN"], ["EM"], ["SUB"], ["ESC", "\\e"], ["FS"],
  ["GS"], ["RS"], ["US"],
];
const c1 = ["PAD", "HOP", "BPH", "NBH", "IND", "NEL", "SSA", "ESA", "HTS", "HTJ", "VTS", "PLD", "PLU", "RI", "SS2", "SS3", "DCS", "PU1", "PU2", "STS", "CCH", "MW", "SPA", "EPA", "SOS", "SGCI", "SCI", "CSI", "ST", "OSC", "PM", "APC"];
const describe = (code: string) => `${code} – ${t(`ascii.${code}` as TextKey)}`;
export function asciiRows(extended = false): AsciiRow[] {
  return Array.from({ length: 128 }, (_, index) => {
    const decimal = index + (extended ? 128 : 0);
    const control = controls[decimal];
    const hex = decimal.toString(16).toUpperCase().padStart(2, "0");
    let character = String.fromCharCode(decimal);
    let name = t("ascii.char", { character });
    if (control) { character = [control[1] ?? `\\x${hex}`, `^${String.fromCharCode(decimal + 64)}`].join(" / "); name = describe(control[0]); }
    else if (decimal === 127) { character = "\\x7F / ^?"; name = t("ascii.del"); }
    else if (decimal >= 128 && decimal <= 159) { character = `\\x${hex}`; name = describe(c1[decimal - 128]); }
    else if (decimal === 32) { character = "␠"; name = t("ascii.sp"); }
    else if (decimal === 160) { character = "NBSP"; name = t("ascii.nbsp"); }
    else if (decimal === 173) { character = "SHY"; name = t("ascii.shy"); }
    return { decimal, hex, octal: decimal.toString(8).padStart(3, "0"), character, name };
  });
}
export function searchAscii(rows: AsciiRow[], query: string): AsciiRow[] {
  if (!query) return rows;
  const q = query.toLocaleLowerCase();
  if (/^0x[0-9a-f]+$/i.test(q)) return rows.filter(row => row.decimal === Number.parseInt(q.slice(2), 16));
  return rows.filter(row => String(row.decimal) === q || row.hex.toLowerCase() === q || row.character.toLocaleLowerCase().includes(q) || row.name.toLocaleLowerCase().includes(q) || String.fromCharCode(row.decimal) === query);
}
