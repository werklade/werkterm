import { writeClipboardText } from "../lib/clipboard";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { asciiRows, searchAscii } from "../lib/ascii";
import { PasswordField } from "./PasswordField";
import { useModal } from "./useModal";
import { useT, type TextKey } from "../i18n";

interface LocalPort { protocol: string; address: string; port: number; pid: number | null; process: string | null }
interface KeyStart { id: number; comment: string; directory: string }
interface PublicKey { public_key: string; fingerprint: string }

export function ToolDialog({ kind, onClose }: { kind: "ascii" | "ports" | "keygen"; onClose(): void }) {
  const t = useT();
  const dialog = useModal();
  const [error, setError] = useState("");
  const title = kind === "ascii" ? t("menu.tools.ascii") : kind === "ports" ? t("menu.tools.ports") : t("menu.tools.keygen");
  const copy = (value: string) => { void writeClipboardText(value).then(() => setError(t("tool.copied"))).catch(() => setError(t("clipboard.unavailable"))); };
  return <dialog ref={dialog} className="ssh-dialog tool-dialog" aria-modal="true" aria-labelledby="tool-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id="tool-title">{title}</h2>
    {kind === "ascii" ? <AsciiTool onCopy={copy} /> : kind === "ports" ? <PortsTool /> : <KeygenTool onCopy={copy} />}
    {error && <p role="status">{error}</p>}
    <div className="dialog-actions"><button onClick={onClose}>{t("common.close")}</button></div>
  </dialog>;
}

const asciiColumns = ["ascii.col.decimal", "ascii.col.hex", "ascii.col.octal", "ascii.col.character", "ascii.col.name"] as const;
function AsciiTool({ onCopy }: { onCopy(value: string): void }) {
  const t = useT();
  const [extended, setExtended] = useState(false);
  const [query, setQuery] = useState("");
  return <>
    <div className="tool-controls"><input aria-label={t("ascii.search.label")} placeholder={t("ascii.search.placeholder")} value={query} onChange={event => setQuery(event.target.value)} />
      <label><input type="checkbox" checked={extended} onChange={event => setExtended(event.target.checked)} />{t("ascii.extended")}</label></div>
    <div className="tool-table-scroll"><table className="tool-table"><thead><tr>{asciiColumns.map(label => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{searchAscii(asciiRows(extended), query).map(row => <tr key={row.decimal}>{[String(row.decimal), row.hex, row.octal, row.character, row.name].map((value, index) => <td key={index}><button title={t("tool.copyValue")} onClick={() => onCopy(value)}>{value}</button></td>)}</tr>)}</tbody></table></div>
  </>;
}

const portColumns: [keyof LocalPort, TextKey][] = [["protocol", "ports.col.protocol"], ["address", "ports.col.address"], ["port", "ports.col.port"], ["pid", "ports.col.pid"], ["process", "ports.col.process"]];
function PortsTool() {
  const t = useT();
  const [ports, setPorts] = useState<LocalPort[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: keyof LocalPort; ascending: boolean }>({ key: "port", ascending: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const mounted = useRef(true);
  const refresh = () => {
    setBusy(true); setError(false);
    void invoke<LocalPort[]>("local_ports").then(rows => { if (mounted.current) setPorts(rows); }).catch(() => { if (mounted.current) setError(true); }).finally(() => { if (mounted.current) setBusy(false); });
  };
  useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; }; }, []);
  const rows = ports.filter(port => Object.values(port).some(value => String(value ?? "–").toLocaleLowerCase().includes(query.toLocaleLowerCase()))).sort((a, b) => {
    const left = a[sort.key]; const right = b[sort.key];
    const result = typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true });
    return sort.ascending ? result : -result;
  });
  return <>
    <div className="tool-controls"><input aria-label={t("ports.filter.label")} placeholder={t("ports.filter.placeholder")} value={query} onChange={event => setQuery(event.target.value)} /><button disabled={busy} onClick={refresh}>{busy ? t("app.loading") : t("app.refresh")}</button></div>
    <p>{t("ports.note")}</p>
    {error && <p role="alert">{t("ports.loadError")}</p>}
    <div className="tool-table-scroll"><table className="tool-table"><thead><tr>{portColumns.map(([key, label]) => <th key={key} aria-sort={sort.key === key ? sort.ascending ? "ascending" : "descending" : "none"}><button onClick={() => setSort(current => ({ key, ascending: current.key === key ? !current.ascending : true }))}>{t(label)}{sort.key === key ? sort.ascending ? " ↑" : " ↓" : ""}</button></th>)}</tr></thead>
      <tbody>{rows.map((port, index) => <tr key={index}>{portColumns.map(([key]) => <td key={key}>{port[key] ?? "–"}</td>)}</tr>)}</tbody></table>{!busy && rows.length === 0 && <p>{t("ports.empty")}</p>}</div>
  </>;
}

function KeygenTool({ onCopy }: { onCopy(value: string): void }) {
  const t = useT();
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
    void invoke<string>("platform").then(value => { if (!disposed) setPlatform(value); }).catch(() => { if (!disposed) setMessage(t("keygen.platformError")); });
    void invoke<KeyStart>("keygen_begin").then(value => {
      id = value.id;
      if (disposed) { void invoke("keygen_close", { id }).catch(() => undefined); return; }
      setStart(value); setComment(value.comment);
    }).catch(() => { if (!disposed) setMessage(t("keygen.prepareError")); });
    return () => { disposed = true; mounted.current = false; overwriteAnswer.current?.(false); overwriteAnswer.current = null; unsafeSaveAnswer.current?.(false); unsafeSaveAnswer.current = null; if (id !== undefined) void invoke("keygen_close", { id }).catch(() => undefined); };
  }, []);
  const generate = async () => {
    if (!start || busy || password !== repeat) return;
    setBusy(true); setMessage(""); setResult(null);
    try {
      const value = await invoke<PublicKey>("keygen_generate", { id: start.id, kind, bits, comment, passphrase: password });
      if (mounted.current) { setResult(value); setGeneratedKind(kind); setEncrypted(password.length > 0); }
    } catch { if (mounted.current) setMessage(t("keygen.generateError")); }
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
      const path = await save({ title: privateKey ? t("keygen.dialogPrivate") : t("keygen.dialogPublic"), defaultPath: await join(start.directory, name + (privateKey ? "" : ".pub")) });
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
      if (mounted.current) setMessage(t("keygen.saved"));
    } catch { if (mounted.current) setMessage(t("keygen.saveError")); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <div className="keygen-tool">
    {platform === "windows" && <p role="alert"><strong>{t("keygen.windowsWarning")}</strong></p>}
    <label>{t("keygen.type")}<select disabled={busy} value={kind} onChange={event => setKind(event.target.value)}><option value="ed25519">Ed25519</option><option value="rsa">RSA</option></select></label>
    {kind === "rsa" && <label>{t("keygen.length")}<select disabled={busy} value={bits} onChange={event => setBits(Number(event.target.value))}><option value={3072}>{t("keygen.bits", { bits: 3072 })}</option><option value={4096}>{t("keygen.bits", { bits: 4096 })}</option></select></label>}
    <label>{t("keygen.comment")}<input disabled={busy} value={comment} maxLength={1024} onChange={event => setComment(event.target.value)} /></label>
    <label>{t("keygen.passphrase")}<PasswordField disabled={busy} autoComplete="new-password" value={password} visible={visible} onToggle={() => setVisible(value => !value)} onChange={event => setPassword(event.target.value)} /></label>
    <label>{t("keygen.repeat")}<PasswordField disabled={busy} autoComplete="new-password" value={repeat} visible={repeatVisible} onToggle={() => setRepeatVisible(value => !value)} onChange={event => setRepeat(event.target.value)} /></label>
    {password !== repeat && <p role="alert">{t("keygen.mismatch")}</p>}
    <button disabled={!start || busy || password !== repeat} onClick={() => void generate()}>{busy ? t("keygen.generating") : t("keygen.generate")}</button>
    {result && <><label>{t("keygen.publicKey")}<textarea readOnly rows={4} value={result.public_key} /></label><button onClick={() => onCopy(result.public_key)}>{t("app.copy")}</button><p className="key-fingerprint">{result.fingerprint}</p><div className="tool-controls"><button disabled={busy || platform === null} onClick={() => void saveKey(true)}>{t("keygen.savePrivate")}</button><button disabled={busy || platform === null} onClick={() => void saveKey(false)}>{t("keygen.savePublic")}</button></div></>}
    {unsafeSaveOpen && <UnencryptedKeyDialog onAnswer={answer => { setUnsafeSaveOpen(false); unsafeSaveAnswer.current?.(answer); unsafeSaveAnswer.current = null; }} />}
    {overwriteOpen && <OverwriteDialog onAnswer={answer => { setOverwriteOpen(false); overwriteAnswer.current?.(answer); overwriteAnswer.current = null; }} />}
    {message && <p role="status">{message}</p>}
  </div>;
}

function OverwriteDialog({ onAnswer }: { onAnswer(answer: boolean): void }) {
  const t = useT();
  const dialog = useModal();
  return <dialog ref={dialog} className="ssh-dialog" aria-modal="true" aria-labelledby="key-overwrite-title" onCancel={event => { event.preventDefault(); onAnswer(false); }}>
    <h2 id="key-overwrite-title">{t("keygen.overwrite.title")}</h2>
    <p>{t("keygen.overwrite.text")}</p>
    <div className="dialog-actions"><button autoFocus onClick={() => onAnswer(false)}>{t("common.cancel")}</button><button onClick={() => onAnswer(true)}>{t("keygen.overwrite.confirm")}</button></div>
  </dialog>;
}

function UnencryptedKeyDialog({ onAnswer }: { onAnswer(answer: boolean): void }) {
  const t = useT();
  const dialog = useModal();
  return <dialog ref={dialog} className="ssh-dialog" aria-modal="true" aria-labelledby="key-unencrypted-title" onCancel={event => { event.preventDefault(); onAnswer(false); }}>
    <h2 id="key-unencrypted-title">{t("keygen.unencrypted.title")}</h2>
    <p>{t("keygen.unencrypted.text")}</p>
    <div className="dialog-actions"><button autoFocus onClick={() => onAnswer(false)}>{t("common.cancel")}</button><button onClick={() => onAnswer(true)}>{t("common.save")}</button></div>
  </dialog>;
}
