import { useId } from "react";
import { useModal } from "./useModal";
import { t, useT } from "../i18n";
import type { ChoiceFeedback, DataDirChoice, DataDirStatus } from "../lib/dataDir";
import "./DataDirDialog.css";

export type DataDirMode = "setup" | "change" | "unreachable";
export type DataDirView = "unreachable" | "choose";

export interface DataDirFormProps {
  mode: DataDirMode;
  view: DataDirView;
  status: DataDirStatus;
  choice: DataDirChoice | null;
  /** null until the inspection of `choice` has finished. */
  feedback: ChoiceFeedback | null;
  inspecting: boolean;
  copy: boolean;
  busy: boolean;
  error: string;
  onPick(): void;
  onDefault(): void;
  onCopy(value: boolean): void;
  onSubmit(): void;
  onRetry(): void;
  onBack(): void;
  onCancel?(): void;
  /** Short hint shown above the choices (e.g. after resetting the pointer file). */
  notice?: string;
}

export const unreachableDefaultHint = (): string => t("dataDir.unreachable.defaultHint");
/** Notice code (not display text): DataDirForm shows the translated text for it, any other `notice` is shown as given. */
export const resetPointerNotice = "RESET_POINTER_NOTICE";
const noticeText = (notice: string): string => notice === resetPointerNotice ? t("dataDir.resetPointerNotice") : notice;

export const restartNote = (mode: DataDirMode, choice: DataDirChoice | null): string =>
  mode === "change" ? t("dataDir.restart.change")
    : choice?.kind === "folder" ? t("dataDir.restart.setup") : "";

/** Presentational part of the data folder dialog; all state lives in DataDirDialog. */
export function DataDirForm(p: DataDirFormProps) {
  useT(); // re-render when the language changes; texts come from the module-level t
  const modal = useModal();
  const titleId = useId();
  const canSubmit = !!p.choice && !!p.feedback?.canConfirm && !p.busy && !p.inspecting;
  const note = restartNote(p.mode, p.choice);
  const showDefault = p.mode !== "change" || p.status.custom;
  // The dialog stays until a choice is made; only the change dialog may be dismissed with Esc.
  return <dialog ref={modal} className="ssh-dialog datadir-dialog" aria-modal="true" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (p.mode === "change" && !p.busy) p.onCancel?.(); }}>
    {p.view === "unreachable" ? <>
      <h2 id={titleId}>{t("dataDir.unreachable.title")}</h2>
      <p>{t("dataDir.unreachable.intro")}</p>
      <code className="datadir-path">{p.status.path}</code>
      <p>{t("dataDir.unreachable.hint")}</p>
      {p.error && <p role="alert" className="datadir-error">{p.error}</p>}
      <div className="datadir-choices">
        <div>
          <button type="button" disabled={p.busy} onClick={p.onDefault}>{t("dataDir.useDefault")}</button>
          <small className="datadir-hint-text">{unreachableDefaultHint()}</small>
        </div>
        <div><button type="button" disabled={p.busy} onClick={p.onPick}>{t("dataDir.chooseOther")}</button></div>
      </div>
      <div className="dialog-actions">
        <button type="submit" autoFocus disabled={p.busy} onClick={p.onRetry}>{t("dataDir.retry")}</button>
      </div>
    </> : <>
      <h2 id={titleId}>{p.mode === "change" ? t("dataDir.title.change") : t("dataDir.title.choose")}</h2>
      <p>{t("dataDir.contents")}</p>
      {p.notice && <p role="status" className="datadir-note">{noticeText(p.notice)}</p>}
      {p.mode === "change" && <><p>{t("dataDir.current")}</p><code className="datadir-path">{p.status.path}</code></>}
      <div className="datadir-choices">
        {showDefault && <div>
          <button type="button" disabled={p.busy} onClick={p.onDefault}>{t("dataDir.useDefault")}</button>
          <small className="datadir-hint">{p.status.defaultPath}</small>
        </div>}
        <div><button type="button" autoFocus disabled={p.busy} onClick={p.onPick}>{t("dataDir.choose")}</button></div>
      </div>
      {p.choice && <><p>{p.choice.kind === "default" ? t("dataDir.choice.default") : t("dataDir.choice.folder")}</p><code className="datadir-path">{p.choice.path}</code></>}
      {p.inspecting && <p role="status" className="datadir-note">{t("dataDir.inspecting")}</p>}
      {p.feedback && (p.feedback.tone === "error"
        ? <p role="alert" className="datadir-error">{p.feedback.message}</p>
        : <p role="status" className="datadir-note">{p.feedback.message}</p>)}
      {p.feedback?.showCopy && <label><input type="checkbox" checked={p.copy} disabled={p.busy} onChange={event => p.onCopy(event.target.checked)} />{t("dataDir.copyData")}</label>}
      {note && <p className="datadir-note">{note}</p>}
      {p.error && <p role="alert" className="datadir-error">{p.error}</p>}
      <div className="dialog-actions">
        {p.mode === "unreachable" && <button type="button" disabled={p.busy} onClick={p.onBack}>{t("dataDir.back")}</button>}
        {p.mode === "change" && <button type="button" disabled={p.busy} onClick={() => p.onCancel?.()}>{t("common.cancel")}</button>}
        <button type="submit" disabled={!canSubmit} onClick={p.onSubmit}>{t("dataDir.apply")}</button>
      </div>
    </>}
  </dialog>;
}

export interface DataDirErrorDialogProps { message: string; busy: boolean; error: string; onRetry(): void; onReset(): void }
/** Shown when data_dir_status itself fails (e.g. unknown pointer file version). Nothing is written until resolved. */
export function DataDirErrorDialog(p: DataDirErrorDialogProps) {
  useT();
  const modal = useModal();
  const titleId = useId();
  return <dialog ref={modal} className="ssh-dialog datadir-dialog" aria-modal="true" aria-labelledby={titleId} onCancel={event => event.preventDefault()}>
    <h2 id={titleId}>{t("dataDir.unreadable.title")}</h2>
    <p role="alert" className="datadir-error">{p.message}</p>
    <p>{t("dataDir.unreadable.hint")}</p>
    {p.error && <p role="alert" className="datadir-error">{p.error}</p>}
    <div className="dialog-actions">
      <button type="button" disabled={p.busy} onClick={p.onReset}>{t("dataDir.unreadable.reset")}</button>
      <button type="submit" autoFocus disabled={p.busy} onClick={p.onRetry}>{t("dataDir.retry")}</button>
    </div>
  </dialog>;
}

export interface RestartDialogProps { busy: boolean; error: string; onRestart(): void; /** The restart follows an installed update instead of a folder switch. */ update?: boolean; /** Windows: the installer did not start; the update was not installed. */ notInstalled?: boolean }
/** Shown after the folder was switched but the restart failed; writing stays blocked, the only action is restarting. */
export function RestartDialog(p: RestartDialogProps) {
  useT();
  const modal = useModal();
  const titleId = useId();
  return <dialog ref={modal} className="ssh-dialog datadir-dialog" aria-modal="true" aria-labelledby={titleId} onCancel={event => event.preventDefault()}>
    <h2 id={titleId}>{t("dataDir.restartDialog.title")}</h2>
    <p>{p.notInstalled ? t("error.UPDATE_RESTART_REQUIRED") : p.update ? t("dataDir.restartDialog.update") : t("dataDir.restartDialog.folder")}</p>
    {p.error && <p role="alert" className="datadir-error">{p.error}</p>}
    <div className="dialog-actions"><button type="submit" autoFocus disabled={p.busy} onClick={p.onRestart}>{t("dataDir.restartDialog.restart")}</button></div>
  </dialog>;
}

export interface DataDirSectionProps { status: DataDirStatus | null; error: string; onChange(): void; onDefault(): void }
/** "Datenordner" block of the settings dialog. */
export function DataDirSection({ status, error, onChange, onDefault }: DataDirSectionProps) {
  useT();
  return <>
    <h3>{t("settings.tab.dataDir")}</h3>
    {status ? <>
      <p>{t("dataDir.section.contents")}</p>
      <div><p>{t("dataDir.current")}</p><code className="datadir-path">{status.path}</code></div>
      {!status.reachable && <p role="alert" className="datadir-error">{t("dataDir.section.unreachable")}</p>}
      <div className="datadir-section-actions">
        <button type="button" onClick={onChange}>{t("dataDir.section.change")}</button>
        {status.custom && <button type="button" onClick={onDefault}>{t("dataDir.useDefault")}</button>}
      </div>
    </> : <p role="status">{t("dataDir.section.loading")}</p>}
    {error && <p role="alert" className="datadir-error">{error}</p>}
  </>;
}
