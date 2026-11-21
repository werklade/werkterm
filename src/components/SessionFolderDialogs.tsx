import { useState } from "react";
import { useT } from "../i18n";
import { normalizeFolder, validFolderName } from "../lib/sessions";
import { useModal } from "./useModal";

/** Keyboard path for every drag: choose a folder from the list or type a new path ("" = top level). */
export function SessionMoveDialog({ title, folders, allowed, onAnswer }: {
  title: string;
  folders: readonly string[];
  allowed: (target: string) => boolean;
  onAnswer: (target: string | null) => void;
}) {
  const t = useT();
  const dialog = useModal();
  const [path, setPath] = useState("");
  // "Not possible" is announced only after the user chose or typed something, not on open.
  const [touched, setTouched] = useState(false);
  const choose = (value: string) => { setPath(value); setTouched(true); };
  const target = normalizeFolder(path);
  const valid = !/\p{Cc}/u.test(path) && allowed(target);
  return <dialog ref={dialog} className="ssh-dialog session-move-dialog" aria-modal="true" aria-labelledby="session-move-title" onCancel={event => { event.preventDefault(); onAnswer(null); }}>
    <form onSubmit={event => { event.preventDefault(); if (valid) onAnswer(target); }}>
      <h2 id="session-move-title">{title}</h2>
      <label>{t("sessions.moveDialog.folders")}
        <select data-autofocus size={Math.min(10, Math.max(4, folders.length + 1))} value={folders.includes(target) ? target : target ? "\u0000" : ""} onChange={event => choose(event.target.value)}>
          <option value="">{t("sessions.root")}</option>
          {folders.map(folder => <option key={folder} value={folder}>{folder}</option>)}
          {target && !folders.includes(target) && <option value={"\u0000"} disabled>{t("sessions.moveDialog.newPath", { folder: target })}</option>}
        </select>
      </label>
      <label>{t("sessions.moveDialog.path")}
        <input value={path} onChange={event => choose(event.target.value)} placeholder={t("sessions.moveDialog.placeholder")} aria-invalid={touched && !valid} aria-describedby="session-move-hint" />
      </label>
      <p id="session-move-hint" role={touched && !valid ? "alert" : undefined}>{touched && !valid ? t("sessions.moveDialog.notAllowed") : t("sessions.moveDialog.hint")}</p>
      <div className="dialog-actions">
        <button type="submit" disabled={!valid}>{t("sessions.moveDialog.confirm")}</button>
        <button type="button" onClick={() => onAnswer(null)}>{t("common.cancel")}</button>
      </div>
    </form>
  </dialog>;
}

/** Name of a new empty folder inside `parent`. */
export function SessionFolderNameDialog({ title, onAnswer }: { title: string; onAnswer: (name: string | null) => void }) {
  const t = useT();
  const dialog = useModal();
  const [name, setName] = useState("");
  const valid = validFolderName(name);
  return <dialog ref={dialog} className="ssh-dialog" aria-modal="true" aria-labelledby="session-folder-title" onCancel={event => { event.preventDefault(); onAnswer(null); }}>
    <form onSubmit={event => { event.preventDefault(); if (valid) onAnswer(name.trim()); }}>
      <h2 id="session-folder-title">{title}</h2>
      <input data-autofocus aria-label={t("sessions.folderName")} value={name} onChange={event => setName(event.target.value)} aria-invalid={name.length > 0 && !valid} />
      {name.length > 0 && !valid && <p role="alert">{t("sessions.folderNameInvalid")}</p>}
      <div className="dialog-actions">
        <button type="submit" disabled={!valid}>{t("sessions.newFolder.confirm")}</button>
        <button type="button" onClick={() => onAnswer(null)}>{t("common.cancel")}</button>
      </div>
    </form>
  </dialog>;
}
