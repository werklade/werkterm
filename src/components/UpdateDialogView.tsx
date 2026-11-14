import { useId } from "react";
import { errorText } from "../lib/backendError";
import { useModal } from "./useModal";
import { t, useT } from "../i18n";
import {
  aptCommand, aptRepoNote, blockedFallback, canCloseUpdateDialog, formatPubDate, installKindLabel, progressPercent, restartHints, progressText, updateAction, updateDownloadUrl,
  type AvailableUpdate, type UpdateInfo, type UpdateState,
} from "../lib/updateState";
import "./UpdateDialog.css";

export interface UpdateDialogViewProps {
  state: UpdateState;
  /** Result of the last copy attempt ("Kopiert" or an error text); empty when none. */
  copyNote: string;
  copyFailed: boolean;
  onClose(): void;
  onInstall(): void;
  onRetry(): void;
  onCopy(text: string): void;
}

export const updateRestartNote = (): string => t("update.restart.linux");
export const windowsRestartNote = (): string => t("update.restart.windows");
export const adminNote = (): string => t("update.restart.admin");
export const aptNote = (): string => t("update.aptNote");
export const downloadNote = (): string => t("update.downloadNote");
export const cancelBlockedNote = (): string => t("update.cancelBlocked");
export const notConfiguredNote = (): string => t("update.notConfigured");

const copyField = (p: UpdateDialogViewProps, text: string) => <div className="update-copy">
  <code>{text}</code>
  <button type="button" onClick={() => p.onCopy(text)}>{t("update.copy")}</button>
</div>;

function details(info: UpdateInfo) {
  return <p className="update-meta">{t("update.installed", { version: info.currentVersion, kind: installKindLabel(info.installKind) })}{info.channel === "test" ? ` · ${t("update.channel.test")}` : ""}</p>;
}

function offer(p: UpdateDialogViewProps, info: UpdateInfo, update: AvailableUpdate) {
  const action = updateAction(info);
  const date = formatPubDate(update.pubDate);
  return <>
    <p role="status" className="update-headline">{t("update.available", { version: update.version })}</p>
    {date && <p className="update-meta">{t("update.published", { date })}</p>}
    {update.notes && <>
      <h3 id="update-notes-title">{t("update.notes")}</h3>
      {/* Server text: rendered as plain text only, scrollable via keyboard. */}
      <pre className="update-notes" tabIndex={0} aria-labelledby="update-notes-title">{update.notes}</pre>
    </>}
    {action === "install" && restartHints(info.installKind).map(hint => <p key={hint} className="update-note">{hint}</p>)}
    {action === "blocked" && <><p className="update-note">{info.blockedReason?.trim() ? errorText(info.blockedReason.trim()) : blockedFallback()}</p><p className="update-note">{downloadNote()}</p>{copyField(p, updateDownloadUrl)}</>}
    {action === "apt" && <><p className="update-note">{aptNote()}</p>{copyField(p, aptCommand)}<p className="update-note">{aptRepoNote()}</p></>}
    {action === "download" && <><p className="update-note">{downloadNote()}</p>{copyField(p, updateDownloadUrl)}</>}
    {p.copyNote && <p role={p.copyFailed ? "alert" : "status"} className={p.copyFailed ? "update-error" : "update-note"}>{p.copyNote}</p>}
  </>;
}

/** Presentational part of the update dialog; all state lives in UpdateDialog. */
export function UpdateDialogView(p: UpdateDialogViewProps) {
  useT(); // re-render when the language changes; texts come from the module-level t
  const modal = useModal();
  const titleId = useId();
  const state = p.state;
  const canClose = canCloseUpdateDialog(state);
  const info = state.phase === "loading" ? null : state.info;
  const busy = state.phase === "loading" || state.phase === "checking";
  const canInstall = state.phase === "available" && updateAction(state.info) === "install";
  const installing = state.phase === "installing" || state.phase === "restarting";
  const percent = state.phase === "installing" ? progressPercent(state.progress.downloaded, state.progress.total) : null;
  const closeLabel = busy ? t("common.cancel") : t("common.close");
  return <dialog ref={modal} className="ssh-dialog update-dialog" aria-modal="true" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (canClose) p.onClose(); }}>
    <h2 id={titleId}>{state.phase === "available" || installing ? t("update.title.available") : t("update.title.check")}</h2>
    {info?.channel === "test" && <p className="update-channel">{t("update.channel.test")}</p>}
    {busy && <p role="status" className="update-headline">{t("update.searching")}</p>}
    {state.phase === "notConfigured" && <><p role="status">{notConfiguredNote()}</p>{details(state.info)}</>}
    {state.phase === "current" && <><p role="status" className="update-headline">{t("update.current", { version: state.info.currentVersion })}</p>{details(state.info)}</>}
    {state.phase === "available" && offer(p, state.info, state.update)}
    {(state.phase === "installing" || state.phase === "restarting") && <>
      <p className="update-headline">{state.phase === "restarting" ? t("update.restarting") : t("update.installing", { version: state.update.version })}</p>
      {state.phase === "installing"
        ? <div className="update-progress" role="progressbar" tabIndex={-1} data-initial-focus="" aria-label={t("update.progress.label")}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={progressText(state.progress.downloaded, state.progress.total)}>
            <div className={percent === null ? "update-progress-bar indeterminate" : "update-progress-bar"} style={percent === null ? undefined : { width: `${percent}%` }} />
          </div>
        : <div className="update-progress" role="progressbar" tabIndex={-1} data-initial-focus="" aria-label={t("update.restart.label")} aria-valuemin={0} aria-valuemax={100} aria-valuetext={t("update.restarting.text")}><div className="update-progress-bar indeterminate" /></div>}
      {state.phase === "installing" && <p role="status" className="update-meta">{progressText(state.progress.downloaded, state.progress.total)}</p>}
      <p className="update-note">{cancelBlockedNote()}</p>
    </>}
    {state.phase === "error" && <>
      <p role="alert" className="update-error">{state.message}</p>
      {state.info && details(state.info)}
    </>}
    <div className="dialog-actions">
      <button type="button" disabled={!canClose} onClick={p.onClose} {...(canInstall || state.phase === "error" || installing ? {} : { "data-initial-focus": "" })}>{closeLabel}</button>
      {canInstall && <button type="submit" data-initial-focus="" onClick={p.onInstall}>{t("update.install")}</button>}
      {state.phase === "error" && <button type="submit" data-initial-focus="" onClick={p.onRetry}>{t("update.retry")}</button>}
    </div>
  </dialog>;
}
