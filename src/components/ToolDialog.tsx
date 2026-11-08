import { writeClipboardText } from "../lib/clipboard";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { asciiRows, searchAscii } from "../lib/ascii";
import { PasswordField } from "./PasswordField";
import { useModal } from "./useModal";

interface LocalPort { protocol: string; address: string; port: number; pid: number | null; process: string | null }
interface KeyStart { id: number; comment: string; directory: string }
interface PublicKey { public_key: string; fingerprint: string }

export function ToolDialog({ kind, onClose }: { kind: "ascii" | "ports" | "keygen"; onClose(): void }) {
  const dialog = useModal();
  const [error, setError] = useState("");
  const title = kind === "ascii" ? "ASCII-Tabelle" : kind === "ports" ? "Offene lokale Ports" : "SSH-Schlüssel erzeugen";
  const copy = (value: string) => { void writeClipboardText(value).then(() => setError("Kopiert.")).catch(() => setError("Zwischenablage nicht verfügbar")); };
  return <dialog ref={dialog} className="ssh-dialog tool-dialog" aria-modal="true" aria-labelledby="tool-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id="tool-title">{title}</h2>
    {kind === "ascii" ? <AsciiTool onCopy={copy} /> : kind === "ports" ? <PortsTool /> : <KeygenTool onCopy={copy} />}
    {error && <p role="status">{error}</p>}
    <div className="dialog-actions"><button onClick={onClose}>Schließen</button></div>
  </dialog>;
}

function AsciiTool({ onCopy }: { onCopy(value: string): void }) {
  const [extended, setExtended] = useState(false);
  const [query, setQuery] = useState("");
  return <>
    <div className="tool-controls"><input aria-label="ASCII suchen" placeholder="Zeichen, Dezimalzahl, 0xHex oder Name" value={query} onChange={event => setQuery(event.target.value)} />
      <label><input type="checkbox" checked={extended} onChange={event => setExtended(event.target.checked)} />128–255 (ISO-8859-1)</label></div>
    <div className="tool-table-scroll"><table className="tool-table"><thead><tr>{["Dez", "Hex", "Okt", "Zeichen", "Bezeichnung"].map(label => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{searchAscii(asciiRows(extended), query).map(row => <tr key={row.decimal}>{[String(row.decimal), row.hex, row.octal, row.character, row.name].map((value, index) => <td key={index}><button title="Wert kopieren" onClick={() => onCopy(value)}>{value}</button></td>)}</tr>)}</tbody></table></div>
  </>;
}

function PortsTool() {
  const [ports, setPorts] = useState<LocalPort[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: keyof LocalPort; ascending: boolean }>({ key: "port", ascending: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const refresh = () => {
    setBusy(true); setError("");
    void invoke<LocalPort[]>("local_ports").then(rows => { if (mounted.current) setPorts(rows); }).catch(() => { if (mounted.current) setError("Lokale Ports konnten nicht gelesen werden."); }).finally(() => { if (mounted.current) setBusy(false); });
  };
  useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; }; }, []);
  const rows = ports.filter(port => Object.values(port).some(value => String(value ?? "–").toLocaleLowerCase().includes(query.toLocaleLowerCase()))).sort((a, b) => {
    const left = a[sort.key]; const right = b[sort.key];
    const result = typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true });
    return sort.ascending ? result : -result;
  });
  const columns: [keyof LocalPort, string][] = [["protocol", "Protokoll"], ["address", "Adresse"], ["port", "Port"], ["pid", "PID"], ["process", "Prozess"]];
  return <>
    <div className="tool-controls"><input aria-label="Ports filtern" placeholder="Ports filtern…" value={query} onChange={event => setQuery(event.target.value)} /><button disabled={busy} onClick={refresh}>{busy ? "Lädt…" : "Aktualisieren"}</button></div>
    <p>Für alle Prozesse root-Rechte nötig. Die Anzeige liest nur lokale Betriebssystemdaten.</p>
    {error && <p role="alert">{error}</p>}
    <div className="tool-table-scroll"><table className="tool-table"><thead><tr>{columns.map(([key, label]) => <th key={key} aria-sort={sort.key === key ? sort.ascending ? "ascending" : "descending" : "none"}><button onClick={() => setSort(current => ({ key, ascending: current.key === key ? !current.ascending : true }))}>{label}{sort.key === key ? sort.ascending ? " ↑" : " ↓" : ""}</button></th>)}</tr></thead>
      <tbody>{rows.map((port, index) => <tr key={index}>{columns.map(([key]) => <td key={key}>{port[key] ?? "–"}</td>)}</tr>)}</tbody></table>{!busy && rows.length === 0 && <p>Keine passenden Ports.</p>}</div>
  </>;
}

function KeygenTool({ onCopy }: { onCopy(value: string): void }) {
  const [platform, setPlatform] = useState<string | null>(null);
  const [encrypted, setEncrypted] = useState(false);
  const [start, setStart] = useState<KeyStart | null>(null);
  const [kind, setKind] = useState("ed25519");
  const [bits, setBits] = useState(3072);
  const [comment, setComment] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [visible, setVisible] = useState(false);
  const [repeatVisible, setRepeatVisible] = useState(false);
  const [result, setResult] = useState<PublicKey | null>(null);
  const [unsafeSaveOpen, setUnsafeSaveOpen] = useState(false);
  const unsafeSaveAnswer = useRef<((answer: boolean) => void) | null>(null);
  const [overwriteOpen, setOverwriteOpen] = useState(false);
  const overwriteAnswer = useRef<((answer: boolean) => void) | null>(null);
  const [generatedKind, setGeneratedKind] = useState("ed25519");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    let disposed = false;
    mounted.current = true;
    let id: number | undefined;
    void invoke<string>("platform").then(value => { if (!disposed) setPlatform(value); }).catch(() => { if (!disposed) setMessage("Plattform konnte nicht ermittelt werden."); });
    void invoke<KeyStart>("keygen_begin").then(value => {
      id = value.id;
      if (disposed) { void invoke("keygen_close", { id }).catch(() => undefined); return; }
      setStart(value); setComment(value.comment);
    }).catch(() => { if (!disposed) setMessage("Schlüsseldialog konnte nicht vorbereitet werden."); });
    return () => { disposed = true; mounted.current = false; overwriteAnswer.current?.(false); overwriteAnswer.current = null; unsafeSaveAnswer.current?.(false); unsafeSaveAnswer.current = null; if (id !== undefined) void invoke("keygen_close", { id }).catch(() => undefined); };
  }, []);
  const generate = async () => {
    if (!start || busy || password !== repeat) return;
    setBusy(true); setMessage(""); setResult(null);
    try {
      const value = await invoke<PublicKey>("keygen_generate", { id: start.id, kind, bits, comment, passphrase: password });
      if (mounted.current) { setResult(value); setGeneratedKind(kind); setEncrypted(password.length > 0); }
    } catch { if (mounted.current) setMessage("Schlüssel konnte nicht erzeugt werden."); }
    finally { if (mounted.current) { setPassword(""); setRepeat(""); setBusy(false); } }
  };
  const saveKey = async (privateKey: boolean) => {
    if (!start || !result || busy || platform === null) return;
    setBusy(true); setMessage("");
    try {
      if (privateKey && platform === "windows" && !encrypted) {
        const accepted = await new Promise<boolean>(resolve => { unsafeSaveAnswer.current = resolve; setUnsafeSaveOpen(true); });
        if (!accepted || !mounted.current) return;
      }
      const name = generatedKind === "ed25519" ? "id_ed25519" : "id_rsa";
      const path = await save({ title: privateKey ? "Privaten Schlüssel speichern" : "Öffentlichen Schlüssel speichern", defaultPath: await join(start.directory, name + (privateKey ? "" : ".pub")) });
      if (!path || !mounted.current) return;
      const args = { id: start.id, path, private: privateKey, overwrite: false };
      try { await invoke("keygen_save", args); }
      catch (error: unknown) {
        if (String(error) !== "EXISTS") throw error;
        const accepted = await new Promise<boolean>(resolve => { overwriteAnswer.current = resolve; setOverwriteOpen(true); });
        if (!accepted) return;
        if (!mounted.current) return;
        await invoke("keygen_save", { ...args, overwrite: true });
      }
      if (mounted.current) setMessage("Schlüsseldatei gespeichert.");
    } catch { if (mounted.current) setMessage("Schlüsseldatei konnte nicht gespeichert werden."); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <div className="keygen-tool">
    {platform === "windows" && <p role="alert"><strong>Unter Windows werden die Dateirechte nicht eingeschränkt – Passphrase verwenden</strong></p>}
    <label>Typ<select disabled={busy} value={kind} onChange={event => setKind(event.target.value)}><option value="ed25519">Ed25519</option><option value="rsa">RSA</option></select></label>
    {kind === "rsa" && <label>Schlüssellänge<select disabled={busy} value={bits} onChange={event => setBits(Number(event.target.value))}><option value={3072}>3072 Bit</option><option value={4096}>4096 Bit</option></select></label>}
    <label>Kommentar<input disabled={busy} value={comment} maxLength={1024} onChange={event => setComment(event.target.value)} /></label>
    <label>Passphrase (optional)<PasswordField disabled={busy} autoComplete="new-password" value={password} visible={visible} onToggle={() => setVisible(value => !value)} onChange={event => setPassword(event.target.value)} /></label>
    <label>Passphrase wiederholen<PasswordField disabled={busy} autoComplete="new-password" value={repeat} visible={repeatVisible} onToggle={() => setRepeatVisible(value => !value)} onChange={event => setRepeat(event.target.value)} /></label>
    {password !== repeat && <p role="alert">Passphrasen stimmen nicht überein.</p>}
    <button disabled={!start || busy || password !== repeat} onClick={() => void generate()}>{busy ? "Bitte warten…" : "Erzeugen"}</button>
    {result && <><label>Öffentlicher Schlüssel<textarea readOnly rows={4} value={result.public_key} /></label><button onClick={() => onCopy(result.public_key)}>Kopieren</button><p className="key-fingerprint">{result.fingerprint}</p><div className="tool-controls"><button disabled={busy || platform === null} onClick={() => void saveKey(true)}>Privaten Schlüssel speichern…</button><button disabled={busy || platform === null} onClick={() => void saveKey(false)}>Öffentlichen Schlüssel speichern…</button></div></>}
    {unsafeSaveOpen && <UnencryptedKeyDialog onAnswer={answer => { setUnsafeSaveOpen(false); unsafeSaveAnswer.current?.(answer); unsafeSaveAnswer.current = null; }} />}
    {overwriteOpen && <OverwriteDialog onAnswer={answer => { setOverwriteOpen(false); overwriteAnswer.current?.(answer); overwriteAnswer.current = null; }} />}
    {message && <p role="status">{message}</p>}
  </div>;
}

function OverwriteDialog({ onAnswer }: { onAnswer(answer: boolean): void }) {
  const dialog = useModal();
  return <dialog ref={dialog} className="ssh-dialog" aria-modal="true" aria-labelledby="key-overwrite-title" onCancel={event => { event.preventDefault(); onAnswer(false); }}>
    <h2 id="key-overwrite-title">Schlüsseldatei überschreiben?</h2>
    <p>Diese Datei existiert bereits. Ihr bisheriger Inhalt geht beim Überschreiben verloren. Vorhandene Schlüssel vorher sichern.</p>
    <div className="dialog-actions"><button autoFocus onClick={() => onAnswer(false)}>Abbrechen</button><button onClick={() => onAnswer(true)}>Überschreiben</button></div>
  </dialog>;
}

function UnencryptedKeyDialog({ onAnswer }: { onAnswer(answer: boolean): void }) {
  const dialog = useModal();
  return <dialog ref={dialog} className="ssh-dialog" aria-modal="true" aria-labelledby="key-unencrypted-title" onCancel={event => { event.preventDefault(); onAnswer(false); }}>
    <h2 id="key-unencrypted-title">Privaten Schlüssel ohne Passphrase speichern?</h2>
    <p>Unter Windows werden die Dateirechte nicht eingeschränkt – Passphrase verwenden. Trotzdem ohne Passphrase speichern?</p>
    <div className="dialog-actions"><button autoFocus onClick={() => onAnswer(false)}>Abbrechen</button><button onClick={() => onAnswer(true)}>Speichern</button></div>
  </dialog>;
}
