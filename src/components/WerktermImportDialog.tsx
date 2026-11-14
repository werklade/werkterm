import { useEffect, useId, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { importWerktermSessions, previewWerktermImport, sessionTarget, type ImportResult, type WerktermImportPreview } from "../lib/sessions";
import { useT } from "../i18n";
import { errorText } from "../lib/backendError";
import { useModal } from "./useModal";
import "./SessionDialog.css";
import "./ImportDialog.css";

interface Props { onClose: () => void; onImported: (result: ImportResult) => void }
export function WerktermImportDialog({ onClose, onImported }: Props) {
  const t = useT();
  const dialog = useModal();
  const id = useId();
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<WerktermImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (preview) dialog.current?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
  }, [preview, dialog]);
  const browse = async () => {
    try {
      const value = await open({ title: t("import.werktermPickTitle"), directory: false, multiple: false,
        filters: [{ name: t("session.export.filter"), extensions: ["json"] }] });
      if (typeof value === "string") setPath(value);
    } catch { setError(t("import.pickFailed")); }
  };
  const submit = async () => {
    if (busy || !path.trim() || (preview && !selected.size)) return;
    setBusy(true); setError("");
    try {
      if (preview) onImported(await importWerktermSessions(path, [...selected]));
      else {
        const value = await previewWerktermImport(path);
        setSelected(new Set(value.sessions.filter((_, index) => !value.duplicateOf[index]).map(session => session.id)));
        setPreview(value);
      }
    } catch (reason) { setError(typeof reason === "string" ? reason : t("import.failed")); }
    finally { setBusy(false); }
  };
  const cancel = () => { if (!busy) onClose(); };
  return <dialog ref={dialog} className="ssh-dialog import-dialog" aria-modal="true" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); cancel(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h2 id={`${id}-title`}>{t("import.werktermTitle")}</h2>
      {!preview ? <fieldset disabled={busy} className="session-fields"><label>{t("import.sessionFile")}<div className="session-path-field">
        <input autoFocus required value={path} onChange={event => setPath(event.target.value)} placeholder={t("import.werktermPlaceholder")} />
        <button type="button" title={t("import.browseTitle")} onClick={() => void browse()}>{t("import.browse")}</button>
      </div></label></fieldset> : <>
        <div className="import-selection-actions"><span>{t("import.countOf", { selected: selected.size, total: preview.sessions.length })}</span>
          <button type="button" disabled={busy} onClick={() => setSelected(new Set(preview.sessions.map(session => session.id)))}>{t("import.all")}</button>
          <button type="button" disabled={busy} onClick={() => setSelected(new Set())}>{t("import.none")}</button></div>
        <div className="import-table-scroll"><table><thead><tr><th scope="col">{t("import.col.select")}</th><th scope="col">{t("import.col.name")}</th><th scope="col">{t("import.col.folder")}</th><th scope="col">{t("import.col.target")}</th></tr></thead>
          <tbody>{preview.sessions.map((session, index) => <tr key={session.id} className={preview.duplicateOf[index] ? "import-duplicate" : undefined}>
            <td><input type="checkbox" aria-label={t("import.checkbox", { name: session.name })} disabled={busy} checked={selected.has(session.id)} onChange={event => {
              const checked = event.target.checked;
              setSelected(previous => { const next = new Set(previous); if (checked) next.add(session.id); else next.delete(session.id); return next; });
            }} /></td><td>{session.name}{preview.duplicateOf[index] && <span className="import-duplicate-label">{t("import.exists")}</span>}</td><td>{session.folder || "—"}</td><td>{sessionTarget(session)}</td>
          </tr>)}</tbody></table></div>
        {preview.warnings.length > 0 && <ul className="import-warnings">{preview.warnings.map((warning, index) => <li key={index}>{errorText(warning)}</li>)}</ul>}
      </>}
      {error && <p role="alert" className="session-error">{error}</p>}
      <div className="dialog-actions">{preview && <button type="button" disabled={busy} onClick={() => { setPreview(null); setError(""); }}>{t("import.back")}</button>}
        <button type="submit" disabled={busy || (preview ? !selected.size : !path.trim())}>{busy ? (preview ? t("import.importing") : t("import.loading")) : preview ? t("import.startCount", { count: selected.size }) : t("import.previewLoad")}</button>
        <button type="button" disabled={busy} onClick={cancel}>{t("common.cancel")}</button></div>
    </form>
  </dialog>;
}
