import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useModal } from "./useModal";
import type { SavedSession } from "../lib/sessions";
import { formatBytes, isLoopback, sessionRoute, statusText, validateTunnel, type Tunnel, type TunnelStatus } from "../lib/tunnels";
import "./TunnelDialog.css";
const kinds = { local: "Lokal -L", remote: "Entfernt -R", dynamic: "Dynamisch -D" };
const explanations = { local: "Leitet einen lokalen Port durch SSH zum Ziel weiter.", remote: "Leitet einen Port auf dem SSH-Server zu einem Ziel dieses Rechners weiter.", dynamic: "Stellt einen lokalen SOCKS5-Proxy für CONNECT über SSH bereit." };
export function TunnelDialog({ sessions, tunnels, statuses, reload, start, onClose }: { sessions: SavedSession[]; tunnels: Tunnel[]; statuses: TunnelStatus[]; reload(): Promise<void>; start(t: Tunnel): Promise<void>; onClose(): void }) {
  const [deleting, setDeleting] = useState<Tunnel | null>(null);
  const dialog = useModal(); const [editing, setEditing] = useState<Tunnel | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const perform = async (operation: () => Promise<unknown>) => { setBusy(true); setError(""); try { await operation(); await reload(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const patch = (values: Partial<Tunnel>) => setEditing(t => t ? { ...t, ...values } : t);
  const validation = editing ? validateTunnel(editing, sessions) : "";
  return <dialog ref={dialog} className="ssh-dialog tunnel-dialog" aria-modal="true" aria-labelledby="tunnels-title" onCancel={e => { e.preventDefault(); onClose(); }}>
    <h2 id="tunnels-title">SSH-Tunnel</h2>
    <div className="tool-table-scroll"><table className="tool-table"><thead><tr>{["Name", "Typ", "Quelle", "Ziel", "Sitzung", "Status", "Verbindungen", "Bytes ↑/↓", "Aktionen"].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>
      {tunnels.map(t => { const status = statuses.find(s => s.id === t.id); const active = status && ["connecting", "running", "reconnecting"].includes(status.state); return <tr key={t.id}>
        <td>{t.name}</td><td>{kinds[t.kind]}</td><td>{t.bind_address}:{status?.bound_port ?? t.bind_port}</td><td>{t.kind === "dynamic" ? "SOCKS5 CONNECT" : `${t.target_host}:${t.target_port}`}</td><td>{sessionRoute(t.session_id, sessions)}</td>
        <td><span className={`tunnel-dot ${status?.state ?? "stopped"}`} />{statusText(status)}</td><td>{status?.connections ?? 0}</td><td>{formatBytes(status?.bytes_out ?? 0)} / {formatBytes(status?.bytes_in ?? 0)}</td>
        <td><button disabled={busy} onClick={() => void perform(() => active ? invoke("tunnel_stop", { id: t.id }) : start(t))}>{active ? "Stopp" : "Start"}</button><button disabled={busy || !!active} onClick={() => { setEditing({ ...t }); setError(""); }}>Bearbeiten</button><button disabled={busy} onClick={() => setDeleting(t)}>Löschen</button></td>
      </tr>; })}
    </tbody></table>{tunnels.length === 0 && <p>Keine SSH-Tunnel gespeichert.</p>}</div>
    <button disabled={busy} onClick={() => setEditing({ id: "", name: "", kind: "local", session_id: sessions.find(s => s.kind === "ssh")?.id ?? "", bind_address: "127.0.0.1", bind_port: 8080, target_host: "localhost", target_port: 80, autostart: false, reconnect: false, allow_public: false })}>Neuer Tunnel</button>
    {deleting && <div className="tunnel-warning" role="alert"><p>Tunnel „{deleting.name}“ löschen? Er wird dabei gestoppt.</p><button disabled={busy} onClick={() => void perform(async () => { await invoke("tunnel_delete", { id: deleting.id }); setDeleting(null); })}>Löschen bestätigen</button><button disabled={busy} onClick={() => setDeleting(null)}>Abbrechen</button></div>}
    {editing && <form className="tunnel-editor" onSubmit={e => { e.preventDefault(); if (validation) return; void perform(async () => { await invoke("tunnel_save", { tunnel: editing, publicConfirmed: editing.allow_public }); setEditing(null); }); }}>
      <h3>{editing.id ? "Tunnel bearbeiten" : "Neuer Tunnel"}</h3>
      <label>Name<input value={editing.name} onChange={e => patch({ name: e.target.value })} /></label>
      <label>Typ<select value={editing.kind} onChange={e => { const kind = e.target.value as Tunnel["kind"]; patch({ kind, target_host: kind === "dynamic" ? "" : "localhost", target_port: kind === "dynamic" ? null : 80 }); }}>{Object.entries(kinds).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
      <p>{explanations[editing.kind]}</p>
      <label>Sitzung<select value={editing.session_id} onChange={e => patch({ session_id: e.target.value })}><option value="">SSH-Sitzung wählen</option>{sessions.filter(s => s.kind === "ssh").map(s => <option key={s.id} value={s.id}>{sessionRoute(s.id, sessions)}</option>)}</select></label>
      <label>{editing.kind === "remote" ? "Adresse auf dem Server" : "Lokale Adresse"}<input value={editing.bind_address} onChange={e => patch({ bind_address: e.target.value, allow_public: false })} /></label>
      <label>{editing.kind === "remote" ? "Port auf dem Server (0: automatisch)" : "Lokaler Port"}<input type="number" min={editing.kind === "remote" ? 0 : 1} max={65535} value={editing.bind_port} onChange={e => patch({ bind_port: Number(e.target.value) })} /></label>
      {editing.kind !== "dynamic" && <><label>Ziel-Host<input value={editing.target_host} onChange={e => patch({ target_host: e.target.value })} /></label><label>Ziel-Port<input type="number" min={1} max={65535} value={editing.target_port ?? ""} onChange={e => patch({ target_port: Number(e.target.value) })} /></label></>}
      <label><input type="checkbox" checked={editing.autostart} onChange={e => patch({ autostart: e.target.checked })} />Beim Programmstart starten</label>
      <label><input type="checkbox" checked={editing.reconnect} onChange={e => patch({ reconnect: e.target.checked })} />Automatisch neu verbinden</label>
      {!isLoopback(editing.bind_address) && <div className="tunnel-warning" role="alert"><strong>Andere Geräte im Netzwerk können diesen Tunnel nutzen.</strong><label><input type="checkbox" checked={editing.allow_public} onChange={e => patch({ allow_public: e.target.checked })} />Ich bestätige die Freigabe dieser Adresse, auch für den automatischen Start.</label></div>}
      {validation && <p role="status">{validation}</p>}<div className="dialog-actions"><button type="submit" disabled={busy || !!validation}>Speichern</button><button type="button" onClick={() => setEditing(null)}>Abbrechen</button></div>
    </form>}
    {error && <p role="alert">{error}</p>}<div className="dialog-actions"><button onClick={onClose}>Schließen</button></div>
  </dialog>;
}

export function TunnelConfirmDialog({ onAnswer }: { onAnswer(accepted: boolean): void }) {
  const dialog = useModal();
  return <dialog ref={dialog} className="ssh-dialog" aria-modal="true" aria-labelledby="tunnel-confirm-title" onCancel={e => { e.preventDefault(); onAnswer(false); }}>
    <h2 id="tunnel-confirm-title">Öffentlicher SSH-Tunnel</h2><p role="alert">Andere Geräte im Netzwerk können diesen Tunnel nutzen.</p>
    <div className="dialog-actions"><button onClick={() => onAnswer(false)} autoFocus>Abbrechen</button><button onClick={() => onAnswer(true)}>Freigeben und starten</button></div>
  </dialog>;
}
