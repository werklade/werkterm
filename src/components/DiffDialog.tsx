import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useModal } from "./useModal";
import type { DiffSource } from "../lib/diff";
export function DiffDialog({ onCompare, onClose }: { onCompare(sources: [DiffSource, DiffSource]): Promise<void>; onClose(): void }) {
  const modal = useModal(), [paths, setPaths] = useState<[string, string]>(["", ""]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const choose = async (index: number) => {
    try { const path = await open({ multiple: false, directory: false }); if (typeof path === "string") setPaths(p => index ? [p[0], path] : [path, p[1]]); }
    catch (reason) { setError(String(reason)); }
  };
  const compare = async () => {
    setBusy(true); setError("");
    try { await onCompare(paths.map(path => ({ path, tab: { id: 0, kind: "local", title: "Lokal", exited: false, browserPath: "" } })) as [DiffSource, DiffSource]); onClose(); }
    catch (reason) { setError(String(reason)); setBusy(false); }
  };
  return <dialog ref={modal} className="ssh-dialog" aria-labelledby="diff-dialog-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="diff-dialog-title">Dateien vergleichen</h2>{paths.map((path, i) => <div key={i}><label>Datei {i + 1}<input readOnly value={path} /></label><button disabled={busy} onClick={() => void choose(i)}>Auswählen…</button></div>)}
    {error && <p role="alert">{error}</p>}<div className="dialog-actions"><button disabled={busy || paths.some(p => !p)} onClick={() => void compare()}>Vergleichen</button><button disabled={busy} onClick={onClose}>Abbrechen</button></div>
  </dialog>;
}
