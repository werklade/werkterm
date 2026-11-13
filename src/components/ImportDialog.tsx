import { useEffect, useId, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { applyOneKeyMappings, commitImport, defaultImportSelection, deselectNewImportDuplicates, importDefaultPath, listSessions, markImportDuplicates, previewImport,
  sessionTarget, type ImportPreview, type ImportResult, type OneKeyMapping, type SavedSession, type SessionAuth } from "../lib/sessions";
import { tp, useT } from "../i18n";
import { useModal } from "./useModal";
import "./SessionDialog.css";
import "./ImportDialog.css";

interface Props {
  source: "mobaxterm" | "windterm";
  onClose: () => void;
  onImported: (result: ImportResult) => void;
}

export function ImportDialog({ source, onClose, onImported }: Props) {
  const t = useT();
  const dialog = useModal();
  const id = useId();
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mappings, setMappings] = useState<Record<string, OneKeyMapping>>({});
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sourceName = source === "mobaxterm" ? "MobaXterm" : "WindTerm";
  useEffect(() => {
    let active = true;
    void importDefaultPath(source).then(value => { if (active && value) setPath(current => current || value); }, () => {
      if (active) setError(t("import.defaultPathFailed"));
    });
    return () => { active = false; };
  }, [source, t]);
  useEffect(() => {
    if (preview) dialog.current?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
  }, [preview, dialog]);
  const browse = async () => {
    try {
      const value = await open({ title: t("import.pickTitle", { source: sourceName }), directory: false, multiple: false,
        filters: source === "mobaxterm" ? [{ name: "MobaXterm", extensions: ["ini", "mxtsessions"] }] : [{ name: t("import.windtermFiles"), extensions: ["*"] }] });
      if (typeof value === "string") setPath(value);
    } catch { setError(t("import.pickFailed")); }
  };
  const loadPreview = async () => {
    if (!path.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const [value, sessions] = await Promise.all([previewImport(source, path), listSessions()]);
      const entries = new Map<string, OneKeyMapping>();
      for (const key of value.oneKeys) entries.set(key.uuid, { user: key.name || null, auth: { type: "default" } });
      for (const candidate of value.candidates) {
        if (candidate.oneKey && !entries.has(candidate.oneKey)) entries.set(candidate.oneKey, { user: null, auth: { type: "default" } });
      }
      const initialMappings = Object.fromEntries(entries);
      const resolved = markImportDuplicates(applyOneKeyMappings(value.candidates, initialMappings), sessions);
      setSelected(defaultImportSelection(resolved.map(selection => selection.candidate)));
      setSavedSessions(sessions); setMappings(initialMappings); setPreview(value);
    } catch (reason) { setError(typeof reason === "string" ? reason : t("import.previewFailed")); }
    finally { setBusy(false); }
  };
  const updateMapping = (key: string, changes: Partial<OneKeyMapping>) => {
    const nextMappings = { ...mappings, [key]: { ...mappings[key], ...changes } };
    if (preview) {
      const previous = markImportDuplicates(applyOneKeyMappings(preview.candidates, mappings), savedSessions);
      const next = markImportDuplicates(applyOneKeyMappings(preview.candidates, nextMappings), savedSessions);
      setSelected(current => deselectNewImportDuplicates(current, previous, next));
    }
    setMappings(nextMappings);
  };
  const browseKey = async (key: string) => {
    try {
      const value = await open({ title: t("import.keyPickTitle"), multiple: false, directory: false });
      if (typeof value === "string") updateMapping(key, { auth: { type: "keyFile", path: value } });
    } catch { setError(t("import.keyPickFailed")); }
  };
  const usedKeys = preview ? [...new Set(preview.candidates.flatMap(candidate => candidate.oneKey ? [candidate.oneKey] : []))] : [];
  const resolved = markImportDuplicates(applyOneKeyMappings(preview?.candidates ?? [], mappings), savedSessions);
  const selections = resolved.filter(selection => selected.has(selection.candidate.key));
  const valid = selections.length > 0 && selections.every(selection => selection.auth.type !== "keyFile" || selection.auth.path.trim() !== "");
  const cancel = () => { if (!busy) onClose(); };
  return <dialog ref={dialog} className="ssh-dialog import-dialog" aria-modal="true" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); cancel(); }}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!preview) { void loadPreview(); return; }
      if (!valid || busy) return;
      setBusy(true); setError("");
      void commitImport(selections.map(selection => ({ ...selection, gateway: preview.gateways?.[selection.candidate.key] }))).then(onImported, reason => {
        setError(typeof reason === "string" ? reason : t("import.failed")); setBusy(false);
      });
    }}>
      <h2 id={`${id}-title`}>{t("import.title", { source: sourceName })}</h2>
      {!preview ? <fieldset disabled={busy} className="session-fields"><label>{t("import.sessionFile")}<div className="session-path-field">
        <input autoFocus required value={path} onChange={event => setPath(event.target.value)} placeholder={source === "windterm" ? t("import.windtermFiles") : t("import.mobaxtermFiles")} />
        <button type="button" title={t("import.browseTitle")} onClick={() => void browse()}>{t("import.browse")}</button>
      </div></label></fieldset> : <>
        <div className="import-selection-actions"><span>{t("import.countOf", { selected: selected.size, total: preview.candidates.length })}</span>
          <button type="button" disabled={busy} onClick={() => setSelected(new Set(preview.candidates.map(candidate => candidate.key)))}>{t("import.all")}</button>
          <button type="button" disabled={busy} onClick={() => setSelected(new Set())}>{t("import.none")}</button></div>
        <div className="import-table-scroll"><table><thead><tr><th scope="col">{t("import.col.select")}</th><th scope="col">{t("import.col.name")}</th><th scope="col">{t("import.col.folder")}</th><th scope="col">{t("import.col.target")}</th><th scope="col">{t("import.col.key")}</th></tr></thead>
          <tbody>{resolved.map(({ candidate, user }) => <tr key={candidate.key} className={candidate.duplicateOf ? "import-duplicate" : undefined}>
            <td><input type="checkbox" aria-label={t("import.checkbox", { name: candidate.name })} disabled={busy} checked={selected.has(candidate.key)} onChange={event => {
              const checked = event.target.checked;
              setSelected(previous => { const next = new Set(previous); if (checked) next.add(candidate.key); else next.delete(candidate.key); return next; });
            }} /></td><td>{candidate.name}{candidate.duplicateOf && <span className="import-duplicate-label">{t("import.duplicate")}</span>}</td><td>{candidate.folder || "—"}</td>
            <td>{sessionTarget({ ...candidate, user })}</td><td>{candidate.oneKey ? preview.oneKeys.find(key => key.uuid === candidate.oneKey)?.name ?? candidate.oneKey : candidate.keyPath ?? t("import.defaultKey")}</td>
          </tr>)}</tbody></table></div>
        <p className="session-hint">{t("import.skipped", { count: preview.skipped })}</p>
        {preview.warnings.length > 0 && <ul className="import-warnings">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        {usedKeys.length > 0 && <fieldset disabled={busy} className="import-onekeys"><legend>{t("import.oneKey.legend")}</legend><p className="session-hint">{t("import.oneKey.hint")}</p>
          {usedKeys.map(keyId => {
            const key = preview.oneKeys.find(value => value.uuid === keyId);
            const mapping = mappings[keyId];
            if (!mapping) return null;
            const count = preview.candidates.filter(candidate => candidate.oneKey === keyId).length;
            return <div className="import-onekey" key={keyId}><strong>{key?.name || keyId} <span className="session-hint">{tp("import.oneKey.count", count)}</span></strong>
              <div className="import-onekey-fields"><label>{t("import.user")}<input value={mapping.user ?? ""} onChange={event => updateMapping(keyId, { user: event.target.value || null })} /></label>
                <label>{t("import.auth")}<select value={mapping.auth.type} onChange={event => {
                  const type = event.target.value as Exclude<SessionAuth["type"], "password">;
                  updateMapping(keyId, { auth: type === "keyFile" ? { type, path: "" } : { type } });
                }}><option value="default">{t("import.auth.default")}</option><option value="keyFile">{t("import.auth.keyFile")}</option><option value="ask">{t("import.auth.ask")}</option></select></label></div>
              {mapping.auth.type === "keyFile" && <label>{t("import.keyFile")}<div className="session-path-field"><input value={mapping.auth.path} onChange={event => updateMapping(keyId, { auth: { type: "keyFile", path: event.target.value } })} /><button type="button" title={t("import.keyBrowseTitle")} onClick={() => void browseKey(keyId)}>{t("import.browse")}</button></div></label>}
            </div>;
          })}</fieldset>}
      </>}
      {error && <p role="alert" className="session-error">{error}</p>}
      <div className="dialog-actions">{preview && <button type="button" disabled={busy} onClick={() => { setPreview(null); setError(""); }}>{t("import.back")}</button>}
        <button type="submit" disabled={busy || (preview ? !valid : !path.trim())}>{busy ? (preview ? t("import.importing") : t("import.loading")) : preview ? t("import.start") : t("import.preview")}</button>
        <button type="button" disabled={busy} onClick={cancel}>{t("common.cancel")}</button></div>
    </form>
  </dialog>;
}
