import { useId } from "react";
import { useModal } from "./useModal";
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

export const unreachableDefaultHint = "Dort können ältere Daten liegen. Der gewählte Ordner bleibt unverändert.";
export const resetPointerNotice = "Die bisherige Zeigerdatei bleibt als Sicherung erhalten.";

export const restartNote =(mode: DataDirMode, choice: DataDirChoice | null): string =>
  mode === "change" ? "Werkterm wird neu gestartet. Offene Verbindungen werden getrennt."
    : choice?.kind === "folder" ? "Werkterm wird neu gestartet." : "";

/** Presentational part of the data folder dialog; all state lives in DataDirDialog. */
export function DataDirForm(p: DataDirFormProps) {
  const modal = useModal();
  const titleId = useId();
  const canSubmit = !!p.choice && !!p.feedback?.canConfirm && !p.busy && !p.inspecting;
  const note = restartNote(p.mode, p.choice);
  const showDefault = p.mode !== "change" || p.status.custom;
  // The dialog stays until a choice is made; only the change dialog may be dismissed with Esc.
  return <dialog ref={modal} className="ssh-dialog datadir-dialog" aria-modal="true" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (p.mode === "change" && !p.busy) p.onCancel?.(); }}>
    {p.view === "unreachable" ? <>
      <h2 id={titleId}>Datenordner nicht erreichbar</h2>
      <p>Werkterm erreicht diesen Ordner nicht:</p>
      <code className="datadir-path">{p.status.path}</code>
      <p>Laufwerk oder Cloud-Client prüfen. Einstellungen werden bis zur Lösung nicht gespeichert.</p>
      {p.error && <p role="alert" className="datadir-error">{p.error}</p>}
      <div className="datadir-choices">
        <div>
          <button type="button" disabled={p.busy} onClick={p.onDefault}>Standardordner verwenden</button>
          <small className="datadir-hint-text">{unreachableDefaultHint}</small>
        </div>
        <div><button type="button" disabled={p.busy} onClick={p.onPick}>Anderen Ordner wählen…</button></div>
      </div>
      <div className="dialog-actions">
        <button type="submit" autoFocus disabled={p.busy} onClick={p.onRetry}>Erneut versuchen</button>
      </div>
    </> : <>
      <h2 id={titleId}>{p.mode === "change" ? "Datenordner ändern" : "Datenordner wählen"}</h2>
      <p>Im Datenordner liegen Sitzungen, Tunnel, Makros, Designs und Einstellungen. Passwörter bleiben im Schlüsselbund dieses Geräts.</p>
      {p.notice && <p role="status" className="datadir-note">{p.notice}</p>}
      {p.mode === "change" && <><p>Aktueller Ordner:</p><code className="datadir-path">{p.status.path}</code></>}
      <div className="datadir-choices">
        {showDefault && <div>
          <button type="button" disabled={p.busy} onClick={p.onDefault}>Standardordner verwenden</button>
          <small className="datadir-hint">{p.status.defaultPath}</small>
        </div>}
        <div><button type="button" autoFocus disabled={p.busy} onClick={p.onPick}>Ordner wählen…</button></div>
      </div>
      {p.choice && <><p>{p.choice.kind === "default" ? "Standardordner:" : "Gewählter Ordner:"}</p><code className="datadir-path">{p.choice.path}</code></>}
      {p.inspecting && <p role="status" className="datadir-note">Ordner wird geprüft…</p>}
      {p.feedback && (p.feedback.tone === "error"
        ? <p role="alert" className="datadir-error">{p.feedback.message}</p>
        : <p role="status" className="datadir-note">{p.feedback.message}</p>)}
      {p.feedback?.showCopy && <label><input type="checkbox" checked={p.copy} disabled={p.busy} onChange={event => p.onCopy(event.target.checked)} />Bisherige Daten dorthin kopieren</label>}
      {note && <p className="datadir-note">{note}</p>}
      {p.error && <p role="alert" className="datadir-error">{p.error}</p>}
      <div className="dialog-actions">
        {p.mode === "unreachable" && <button type="button" disabled={p.busy} onClick={p.onBack}>Zurück</button>}
        {p.mode === "change" && <button type="button" disabled={p.busy} onClick={() => p.onCancel?.()}>Abbrechen</button>}
        <button type="submit" disabled={!canSubmit} onClick={p.onSubmit}>Übernehmen</button>
      </div>
    </>}
  </dialog>;
}

export interface DataDirErrorDialogProps { message: string; busy: boolean; error: string; onRetry(): void; onReset(): void }
/** Shown when data_dir_status itself fails (e.g. unknown pointer file version). Nothing is written until resolved. */
export function DataDirErrorDialog(p: DataDirErrorDialogProps) {
  const modal = useModal();
  const titleId = useId();
  return <dialog ref={modal} className="ssh-dialog datadir-dialog" aria-modal="true" aria-labelledby={titleId} onCancel={event => event.preventDefault()}>
    <h2 id={titleId}>Datenordner nicht lesbar</h2>
    <p role="alert" className="datadir-error">{p.message}</p>
    <p>Zurücksetzen sichert die bisherige Zeigerdatei und öffnet die Ordnerwahl.</p>
    {p.error && <p role="alert" className="datadir-error">{p.error}</p>}
    <div className="dialog-actions">
      <button type="button" disabled={p.busy} onClick={p.onReset}>Zurücksetzen und Ordner neu wählen</button>
      <button type="submit" autoFocus disabled={p.busy} onClick={p.onRetry}>Erneut versuchen</button>
    </div>
  </dialog>;
}

export interface RestartDialogProps { busy: boolean; error: string; onRestart(): void; /** The restart follows an installed update instead of a folder switch. */ update?: boolean; /** Windows: the installer did not start; the update was not installed. */ notInstalled?: boolean }
/** Shown after the folder was switched but the restart failed; writing stays blocked, the only action is restarting. */
export function RestartDialog(p: RestartDialogProps) {
  const modal = useModal();
  const titleId = useId();
  return <dialog ref={modal} className="ssh-dialog datadir-dialog" aria-modal="true" aria-labelledby={titleId} onCancel={event => event.preventDefault()}>
    <h2 id={titleId}>Neustart erforderlich</h2>
    <p>{p.notInstalled ? "Das Update wurde nicht installiert. Werkterm muss neu gestartet werden." : p.update ? "Das Update ist installiert. Werkterm muss neu starten, damit es gilt." : "Der Datenordner wurde gewechselt. Werkterm muss neu starten, damit die Änderung gilt."}</p>
    {p.error && <p role="alert" className="datadir-error">{p.error}</p>}
    <div className="dialog-actions"><button type="submit" autoFocus disabled={p.busy} onClick={p.onRestart}>Neu starten</button></div>
  </dialog>;
}

export interface DataDirSectionProps { status: DataDirStatus | null; error: string; onChange(): void; onDefault(): void }
/** "Datenordner" block of the settings dialog. */
export function DataDirSection({ status, error, onChange, onDefault }: DataDirSectionProps) {
  return <>
    <h3>Datenordner</h3>
    {status ? <>
      <p>Hier liegen Sitzungen, Tunnel, Makros, Designs und Einstellungen. Passwörter bleiben im Schlüsselbund dieses Geräts.</p>
      <div><p>Aktueller Ordner:</p><code className="datadir-path">{status.path}</code></div>
      {!status.reachable && <p role="alert" className="datadir-error">Der Ordner ist nicht erreichbar.</p>}
      <div className="datadir-section-actions">
        <button type="button" onClick={onChange}>Ordner ändern…</button>
        {status.custom && <button type="button" onClick={onDefault}>Standardordner verwenden</button>}
      </div>
    </> : <p role="status">Datenordner wird geladen…</p>}
    {error && <p role="alert" className="datadir-error">{error}</p>}
  </>;
}
