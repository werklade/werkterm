import { useState } from "react";
import { errorText } from "../lib/backendError";
import { open } from "@tauri-apps/plugin-dialog";
import { useModal } from "./useModal";
import { useT } from "../i18n";
import type { FolderOptions } from "../lib/folderDiff";
import type { DiffSource } from "../lib/diff";
export function DiffDialog({ onCompare, onClose }: { onCompare(sources: [DiffSource, DiffSource], options: FolderOptions): Promise<void>; onClose(): void }) {
  const t = useT();
  const modal = useModal(), [paths, setPaths] = useState<[string, string]>(["", ""]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [options, setOptions] = useState<FolderOptions>({ recursive: true, contents: false });
  const choose = async (index: number, directory: boolean) => {
    try { const path = await open({ multiple: false, directory }); if (typeof path === "string") setPaths(p => index ? [p[0], path] : [path, p[1]]); }
    catch (reason) { setError(errorText(reason)); }
  };
  const compare = async () => {
    setBusy(true); setError("");
    try { await onCompare(paths.map(path => ({ path, tab: { id: 0, kind: "local", title: t("diff.tab.local"), exited: false, browserPath: "" } })) as [DiffSource, DiffSource], options); onClose(); }
    catch (reason) { setError(errorText(reason)); setBusy(false); }
  };
  return <dialog ref={modal} className="ssh-dialog diff-dialog" aria-labelledby="diff-dialog-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="diff-dialog-title">{t("diff.dialog.title")}</h2>{paths.map((path, i) => <div key={i} className="diff-source"><span id={`diff-source-${i}`}>{t("diff.dialog.source", { number: i + 1 })}</span><div className="diff-source-row"><input aria-labelledby={`diff-source-${i}`} disabled={busy} value={path} onChange={e => setPaths(p => i ? [p[0], e.target.value] : [e.target.value, p[1]])} /><button type="button" className="dialog-button" disabled={busy} onClick={() => void choose(i, false)}>{t("diff.dialog.chooseFile")}</button><button type="button" className="dialog-button" disabled={busy} onClick={() => void choose(i, true)}>{t("diff.dialog.chooseFolder")}</button></div>{i === 0 && <div className="diff-swap"><button type="button" className="dialog-button" disabled={busy} onClick={() => setPaths(([a, b]) => [b, a])}>⇅ {t("diff.swap")}</button></div>}</div>)}
    <label><input type="checkbox" disabled={busy} checked={options.recursive} onChange={e => setOptions({ ...options, recursive: e.target.checked })} />{t("diff.recursive")}</label>
    <label><input type="checkbox" disabled={busy} checked={options.contents} onChange={e => setOptions({ ...options, contents: e.target.checked })} />{t("diff.contents")}</label>
    {error && <p role="alert">{error}</p>}<div className="dialog-actions"><button disabled={busy || paths.some(p => !p)} onClick={() => void compare()}>{t("diff.dialog.compare")}</button><button disabled={busy} onClick={onClose}>{t("common.cancel")}</button></div>
  </dialog>;
}
