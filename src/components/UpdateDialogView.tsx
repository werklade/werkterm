import { useId } from "react";
import { useModal } from "./useModal";
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

export const updateRestartNote = "Werkterm startet danach neu. Offene Verbindungen werden getrennt.";
export const windowsRestartNote = "Werkterm wird beendet und nach dem Update neu gestartet. Offene Verbindungen werden getrennt.";
export const adminNote = "Windows fragt nach dem Beenden nach Administratorrechten. Bei Ablehnung bleibt die bisherige Version installiert; Werkterm dann von Hand starten.";
export const aptNote = "Diese Installation wird über die Paketverwaltung aktualisiert.";
export const downloadNote = "Diese Installation wird von Hand aktualisiert. Die Pakete liegen unter dieser Adresse:";
export const cancelBlockedNote = "Abbrechen ist während der Installation nicht möglich.";
export const notConfiguredNote = "Update-Prüfung ist in diesem Build nicht eingerichtet.";

const copyField = (p: UpdateDialogViewProps, text: string) => <div className="update-copy">
  <code>{text}</code>
  <button type="button" onClick={() => p.onCopy(text)}>Kopieren</button>
</div>;

function details(info: UpdateInfo) {
  return <p className="update-meta">Installiert: Version {info.currentVersion}, {installKindLabel(info.installKind)}{info.channel === "test" ? " · Testkanal" : ""}</p>;
}

function offer(p: UpdateDialogViewProps, info: UpdateInfo, update: AvailableUpdate) {
  const action = updateAction(info);
  const date = formatPubDate(update.pubDate);
  return <>
    <p role="status" className="update-headline">Version {update.version} ist verfügbar</p>
    {date && <p className="update-meta">Veröffentlicht am {date}</p>}
    {update.notes && <>
      <h3 id="update-notes-title">Änderungen</h3>
      {/* Server text: rendered as plain text only, scrollable via keyboard. */}
      <pre className="update-notes" tabIndex={0} aria-labelledby="update-notes-title">{update.notes}</pre>
    </>}
    {action === "install" && restartHints(info.installKind).map(hint => <p key={hint} className="update-note">{hint}</p>)}
    {action === "blocked" && <><p className="update-note">{info.blockedReason?.trim() || blockedFallback}</p><p className="update-note">{downloadNote}</p>{copyField(p, updateDownloadUrl)}</>}
    {action === "apt" && <><p className="update-note">{aptNote}</p>{copyField(p, aptCommand)}<p className="update-note">{aptRepoNote}</p></>}
    {action === "download" && <><p className="update-note">{downloadNote}</p>{copyField(p, updateDownloadUrl)}</>}
    {p.copyNote && <p role={p.copyFailed ? "alert" : "status"} className={p.copyFailed ? "update-error" : "update-note"}>{p.copyNote}</p>}
  </>;
}

/** Presentational part of the update dialog; all state lives in UpdateDialog. */
export function UpdateDialogView(p: UpdateDialogViewProps) {
  const modal = useModal();
  const titleId = useId();
  const state = p.state;
  const canClose = canCloseUpdateDialog(state);
  const info = state.phase === "loading" ? null : state.info;
  const busy = state.phase === "loading" || state.phase === "checking";
  const canInstall = state.phase === "available" && updateAction(state.info) === "install";
  const installing = state.phase === "installing" || state.phase === "restarting";
  const percent = state.phase === "installing" ? progressPercent(state.progress.downloaded, state.progress.total) : null;
  const closeLabel = busy ? "Abbrechen" : "Schließen";
  return <dialog ref={modal} className="ssh-dialog update-dialog" aria-modal="true" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (canClose) p.onClose(); }}>
    <h2 id={titleId}>{state.phase === "available" || installing ? "Update verfügbar" : "Nach Updates suchen"}</h2>
    {info?.channel === "test" && <p className="update-channel">Testkanal</p>}
    {busy && <p role="status" className="update-headline">Suche nach Updates…</p>}
    {state.phase === "notConfigured" && <><p role="status">{notConfiguredNote}</p>{details(state.info)}</>}
    {state.phase === "current" && <><p role="status" className="update-headline">Werkterm ist aktuell (Version {state.info.currentVersion})</p>{details(state.info)}</>}
    {state.phase === "available" && offer(p, state.info, state.update)}
    {(state.phase === "installing" || state.phase === "restarting") && <>
      <p className="update-headline">{state.phase === "restarting" ? "Werkterm wird neu gestartet…" : `Version ${state.update.version} wird installiert…`}</p>
      {state.phase === "installing"
        ? <div className="update-progress" role="progressbar" tabIndex={-1} data-initial-focus="" aria-label="Fortschritt der Installation"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={progressText(state.progress.downloaded, state.progress.total)}>
            <div className={percent === null ? "update-progress-bar indeterminate" : "update-progress-bar"} style={percent === null ? undefined : { width: `${percent}%` }} />
          </div>
        : <div className="update-progress" role="progressbar" tabIndex={-1} data-initial-focus="" aria-label="Neustart" aria-valuemin={0} aria-valuemax={100} aria-valuetext="Werkterm wird neu gestartet"><div className="update-progress-bar indeterminate" /></div>}
      {state.phase === "installing" && <p role="status" className="update-meta">{progressText(state.progress.downloaded, state.progress.total)}</p>}
      <p className="update-note">{cancelBlockedNote}</p>
    </>}
    {state.phase === "error" && <>
      <p role="alert" className="update-error">{state.message}</p>
      {state.info && details(state.info)}
    </>}
    <div className="dialog-actions">
      <button type="button" disabled={!canClose} onClick={p.onClose} {...(canInstall || state.phase === "error" || installing ? {} : { "data-initial-focus": "" })}>{closeLabel}</button>
      {canInstall && <button type="submit" data-initial-focus="" onClick={p.onInstall}>Herunterladen und installieren</button>}
      {state.phase === "error" && <button type="submit" data-initial-focus="" onClick={p.onRetry}>Erneut versuchen</button>}
    </div>
  </dialog>;
}
