export interface AsciiRow { decimal: number; hex: string; octal: string; character: string; name: string }
const controls = [
  ["NUL", "Null", "\\0"], ["SOH", "Beginn der Überschrift"], ["STX", "Textanfang"], ["ETX", "Textende"],
  ["EOT", "Übertragungsende"], ["ENQ", "Anfrage"], ["ACK", "Bestätigung"], ["BEL", "Signalton", "\\a"],
  ["BS", "Rückschritt", "\\b"], ["HT", "Horizontaler Tabulator", "\\t"], ["LF", "Zeilenvorschub", "\\n"],
  ["VT", "Vertikaler Tabulator", "\\v"], ["FF", "Seitenvorschub", "\\f"], ["CR", "Wagenrücklauf", "\\r"],
  ["SO", "Umschaltung aus"], ["SI", "Umschaltung ein"], ["DLE", "Datenverbindung umschalten"],
  ["DC1", "Gerätesteuerung 1"], ["DC2", "Gerätesteuerung 2"], ["DC3", "Gerätesteuerung 3"], ["DC4", "Gerätesteuerung 4"],
  ["NAK", "Negative Bestätigung"], ["SYN", "Synchronisation"], ["ETB", "Übertragungsblockende"], ["CAN", "Abbruch"],
  ["EM", "Medienende"], ["SUB", "Ersetzung"], ["ESC", "Escape", "\\e"], ["FS", "Dateitrenner"],
  ["GS", "Gruppentrenner"], ["RS", "Datensatztrenner"], ["US", "Einheitentrenner"],
];
const c1 = ["PAD – Füllzeichen", "HOP – Hohe Oktettvoreinstellung", "BPH – Umbruch erlaubt", "NBH – Kein Umbruch", "IND – Index", "NEL – Nächste Zeile", "SSA – Markierung beginnen", "ESA – Markierung beenden", "HTS – Tabulator setzen", "HTJ – Tabulator mit Ausrichtung", "VTS – Vertikalen Tabulator setzen", "PLD – Teilzeile abwärts", "PLU – Teilzeile aufwärts", "RI – Rückwärtsindex", "SS2 – Einzelumschaltung 2", "SS3 – Einzelumschaltung 3", "DCS – Gerätesteuerzeichenfolge", "PU1 – Private Verwendung 1", "PU2 – Private Verwendung 2", "STS – Übertragungsstatus setzen", "CCH – Zeichen abbrechen", "MW – Meldung wartet", "SPA – Geschützten Bereich beginnen", "EPA – Geschützten Bereich beenden", "SOS – Zeichenfolge beginnen", "SGCI – Einzelzeichenkennung", "SCI – Einzelzeichen-Einleitung", "CSI – Steuersequenz-Einleitung", "ST – Zeichenfolgenende", "OSC – Betriebssystembefehl", "PM – Private Nachricht", "APC – Anwendungsbefehl"];
export function asciiRows(extended = false): AsciiRow[] {
  return Array.from({ length: 128 }, (_, index) => {
    const decimal = index + (extended ? 128 : 0);
    const control = controls[decimal];
    const hex = decimal.toString(16).toUpperCase().padStart(2, "0");
    let character = String.fromCharCode(decimal);
    let name = `Zeichen ${character}`;
    if (control) { character = [control[2] ?? `\\x${hex}`, `^${String.fromCharCode(decimal + 64)}`].join(" / "); name = `${control[0]} – ${control[1]}`; }
    else if (decimal === 127) { character = "\\x7F / ^?"; name = "DEL – Löschen"; }
    else if (decimal >= 128 && decimal <= 159) { character = `\\x${hex}`; name = c1[decimal - 128]; }
    else if (decimal === 32) { character = "␠"; name = "SP – Leerzeichen"; }
    else if (decimal === 160) { character = "NBSP"; name = "Geschütztes Leerzeichen"; }
    else if (decimal === 173) { character = "SHY"; name = "Weiches Trennzeichen"; }
    return { decimal, hex, octal: decimal.toString(8).padStart(3, "0"), character, name };
  });
}
export function searchAscii(rows: AsciiRow[], query: string): AsciiRow[] {
  if (!query) return rows;
  const q = query.toLocaleLowerCase();
  if (/^0x[0-9a-f]+$/i.test(q)) return rows.filter(row => row.decimal === Number.parseInt(q.slice(2), 16));
  return rows.filter(row => String(row.decimal) === q || row.hex.toLowerCase() === q || row.character.toLocaleLowerCase().includes(q) || row.name.toLocaleLowerCase().includes(q) || String.fromCharCode(row.decimal) === query);
}
