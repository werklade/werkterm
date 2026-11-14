import { useState } from "react";
import { errorText } from "../lib/backendError";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../i18n";
import { useModal } from "./useModal";
import type { SavedSession } from "../lib/sessions";
import { formatBytes, isLoopback, sessionRoute, statusText, validateTunnel, type Tunnel, type TunnelStatus } from "../lib/tunnels";
import "./TunnelDialog.css";
const kinds = { local: "tunnel.kind.local", remote: "tunnel.kind.remote", dynamic: "tunnel.kind.dynamic" } as const;
const explanations = { local: "tunnel.explain.local", remote: "tunnel.explain.remote", dynamic: "tunnel.explain.dynamic" } as const;
const columns = ["tunnel.col.name", "tunnel.col.type", "tunnel.col.source", "tunnel.col.target", "tunnel.col.session", "tunnel.col.status", "tunnel.col.connections", "tunnel.col.bytes", "tunnel.col.actions"] as const;
export function TunnelDialog({ sessions, tunnels, statuses, reload, start, onClose }: { sessions: SavedSession[]; tunnels: Tunnel[]; statuses: TunnelStatus[]; reload(): Promise<void>; start(tunnel: Tunnel): Promise<void>; onClose(): void }) {
  const t = useT();
  const [deleting, setDeleting] = useState<Tunnel | null>(null);
  const dialog = useModal(); const [editing, setEditing] = useState<Tunnel | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const perform = async (operation: () => Promise<unknown>) => { setBusy(true); setError(""); try { await operation(); await reload(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const patch = (values: Partial<Tunnel>) => setEditing(current => current ? { ...current, ...values } : current);
  const validation = editing ? validateTunnel(editing, sessions) : "";
  return <dialog ref={dialog} className="ssh-dialog tunnel-dialog" aria-modal="true" aria-labelledby="tunnels-title" onCancel={e => { e.preventDefault(); onClose(); }}>
    <h2 id="tunnels-title">{t("tunnel.title")}</h2>
    <div className="tool-table-scroll"><table className="tool-table"><thead><tr>{columns.map(key => <th key={key}>{t(key)}</th>)}</tr></thead><tbody>
      {tunnels.map(tunnel => { const status = statuses.find(s => s.id === tunnel.id); const active = status && ["connecting", "running", "reconnecting"].includes(status.state); return <tr key={tunnel.id}>
        <td>{tunnel.name}</td><td>{t(kinds[tunnel.kind])}</td><td>{tunnel.bind_address}:{status?.bound_port ?? tunnel.bind_port}</td><td>{tunnel.kind === "dynamic" ? "SOCKS5 CONNECT" : `${tunnel.target_host}:${tunnel.target_port}`}</td><td>{sessionRoute(tunnel.session_id, sessions)}</td>
        <td><span className={`tunnel-dot ${status?.state ?? "stopped"}`} />{statusText(status)}</td><td>{status?.connections ?? 0}</td><td>{formatBytes(status?.bytes_out ?? 0)} / {formatBytes(status?.bytes_in ?? 0)}</td>
        <td><button disabled={busy} onClick={() => void perform(() => active ? invoke("tunnel_stop", { id: tunnel.id }) : start(tunnel))}>{active ? t("tunnel.stop") : t("tunnel.start")}</button><button disabled={busy || !!active} onClick={() => { setEditing({ ...tunnel }); setError(""); }}>{t("tunnel.edit")}</button><button disabled={busy} onClick={() => setDeleting(tunnel)}>{t("common.delete")}</button></td>
      </tr>; })}
    </tbody></table>{tunnels.length === 0 && <p>{t("tunnel.empty")}</p>}</div>
    <button disabled={busy} onClick={() => setEditing({ id: "", name: "", kind: "local", session_id: sessions.find(s => s.kind === "ssh")?.id ?? "", bind_address: "127.0.0.1", bind_port: 8080, target_host: "localhost", target_port: 80, autostart: false, reconnect: false, allow_public: false })}>{t("tunnel.new")}</button>
    {deleting && <div className="tunnel-warning" role="alert"><p>{t("tunnel.deleteConfirm", { name: deleting.name })}</p><button disabled={busy} onClick={() => void perform(async () => { await invoke("tunnel_delete", { id: deleting.id }); setDeleting(null); })}>{t("tunnel.deleteConfirmButton")}</button><button disabled={busy} onClick={() => setDeleting(null)}>{t("common.cancel")}</button></div>}
    {editing && <form className="tunnel-editor" onSubmit={e => { e.preventDefault(); if (validation) return; void perform(async () => { await invoke("tunnel_save", { tunnel: editing, publicConfirmed: editing.allow_public }); setEditing(null); }); }}>
      <h3>{editing.id ? t("tunnel.editTitle") : t("tunnel.new")}</h3>
      <label>{t("tunnel.field.name")}<input value={editing.name} onChange={e => patch({ name: e.target.value })} /></label>
      <label>{t("tunnel.field.type")}<select value={editing.kind} onChange={e => { const kind = e.target.value as Tunnel["kind"]; patch({ kind, target_host: kind === "dynamic" ? "" : "localhost", target_port: kind === "dynamic" ? null : 80 }); }}>{Object.entries(kinds).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></label>
      <p>{t(explanations[editing.kind])}</p>
      <label>{t("tunnel.field.session")}<select value={editing.session_id} onChange={e => patch({ session_id: e.target.value })}><option value="">{t("tunnel.field.sessionPick")}</option>{sessions.filter(s => s.kind === "ssh").map(s => <option key={s.id} value={s.id}>{sessionRoute(s.id, sessions)}</option>)}</select></label>
      <label>{editing.kind === "remote" ? t("tunnel.field.addr.remote") : t("tunnel.field.addr.local")}<input value={editing.bind_address} onChange={e => patch({ bind_address: e.target.value, allow_public: false })} /></label>
      <label>{editing.kind === "remote" ? t("tunnel.field.port.remote") : t("tunnel.field.port.local")}<input type="number" min={editing.kind === "remote" ? 0 : 1} max={65535} value={editing.bind_port} onChange={e => patch({ bind_port: Number(e.target.value) })} /></label>
      {editing.kind !== "dynamic" && <><label>{t("tunnel.field.targetHost")}<input value={editing.target_host} onChange={e => patch({ target_host: e.target.value })} /></label><label>{t("tunnel.field.targetPort")}<input type="number" min={1} max={65535} value={editing.target_port ?? ""} onChange={e => patch({ target_port: Number(e.target.value) })} /></label></>}
      <label><input type="checkbox" checked={editing.autostart} onChange={e => patch({ autostart: e.target.checked })} />{t("tunnel.field.autostart")}</label>
      <label><input type="checkbox" checked={editing.reconnect} onChange={e => patch({ reconnect: e.target.checked })} />{t("tunnel.field.reconnect")}</label>
      {!isLoopback(editing.bind_address) && <div className="tunnel-warning" role="alert"><strong>{t("tunnel.publicWarning")}</strong><label><input type="checkbox" checked={editing.allow_public} onChange={e => patch({ allow_public: e.target.checked })} />{t("tunnel.publicConfirm")}</label></div>}
      {validation && <p role="status">{validation}</p>}<div className="dialog-actions"><button type="submit" disabled={busy || !!validation}>{t("common.save")}</button><button type="button" onClick={() => setEditing(null)}>{t("common.cancel")}</button></div>
    </form>}
    {error && <p role="alert">{error}</p>}<div className="dialog-actions"><button onClick={onClose}>{t("common.close")}</button></div>
  </dialog>;
}

export function TunnelConfirmDialog({ onAnswer }: { onAnswer(accepted: boolean): void }) {
  const t = useT();
  const dialog = useModal();
  return <dialog ref={dialog} className="ssh-dialog" aria-modal="true" aria-labelledby="tunnel-confirm-title" onCancel={e => { e.preventDefault(); onAnswer(false); }}>
    <h2 id="tunnel-confirm-title">{t("tunnel.confirm.title")}</h2><p role="alert">{t("tunnel.publicWarning")}</p>
    <div className="dialog-actions"><button onClick={() => onAnswer(false)} autoFocus>{t("common.cancel")}</button><button onClick={() => onAnswer(true)}>{t("tunnel.confirm.accept")}</button></div>
  </dialog>;
}
