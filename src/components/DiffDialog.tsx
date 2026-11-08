import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useModal } from "./useModal";
import type { FolderOptions } from "../lib/folderDiff";
import type { DiffSource } from "../lib/diff";
export function DiffDialog({ onCompare, onClose }: { onCompare(sources: [DiffSource, DiffSource], options: FolderOptions): Promise<void>; onClose(): void }) {
  const modal = useModal(), [paths, setPaths] = useState<[string, string]>(["", ""]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [options, setOptions] = useState<FolderOptions>({ recursive: true, contents: false });
  const choose = async (index: number, directory: boolean) => {
    try { const path = await open({ multiple: false, directory }); if (typeof path === "string") setPaths(p => index ? [p[0], path] : [path, p[1]]); }
    catch (reason) { setError(String(reason)); }
  };
  const compare = async () => {
    setBusy(true); setError("");
    try { await onCompare(paths.map(path => ({ path, tab: { id: 0, kind: "local", title: "Lokal", exited: false, browserPath: "" } })) as [DiffSource, DiffSource], options); onClose(); }
    catch (reason) { setError(String(reason)); setBusy(false); }
  };
  return <dialog ref={modal} className="ssh-dialog" aria-labelledby="diff-dialog-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="diff-dialog-title">Dateien oder Ordner vergleichen</h2>{paths.map((path, i) => <div key={i}><label>{i + 1}. Datei oder Ordner<input disabled={busy} value={path} onChange={e => setPaths(p => i ? [p[0], e.target.value] : [e.target.value, p[1]])} /></label><button disabled={busy} onClick={() => void choose(i, false)}>Datei…</button><button disabled={busy} onClick={() => void choose(i, true)}>Ordner…</button></div>)}
    <button disabled={busy} onClick={() => setPaths(([a, b]) => [b, a])}>Seiten tauschen</button>
    <label><input type="checkbox" disabled={busy} checked={options.recursive} onChange={e => setOptions({ ...options, recursive: e.target.checked })} />Unterordner einbeziehen</label>
    <label><input type="checkbox" disabled={busy} checked={options.contents} onChange={e => setOptions({ ...options, contents: e.target.checked })} />Inhalt vergleichen</label>
    {error && <p role="alert">{error}</p>}<div className="dialog-actions"><button disabled={busy || paths.some(p => !p)} onClick={() => void compare()}>Vergleichen</button><button disabled={busy} onClick={onClose}>Abbrechen</button></div>
  </dialog>;
}
