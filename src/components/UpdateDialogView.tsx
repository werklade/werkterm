import { useId } from "react";
import { errorText } from "../lib/backendError";
import { useModal } from "./useModal";
import { t, useT } from "../i18n";
import {
  aptCommand, aptRepoNote, blockedFallback, canCloseUpdateDialog, formatPubDate, installKindLabel, progressPercent, restartHints, progressText, skippedNote, updateAction, updateDownloadUrl,
  type AvailableUpdate, type SkippedManifest, type UpdateInfo, type UpdateState,
} from "../lib/updateState";
import { parseNotes, type Inline, type ListItem } from "../lib/notesMarkdown";
import { aptHint, aptSourcesFile, type AptHint } from "../lib/aptHint";
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
/** Hint that only one manifest was checked, with the reason in the UI language. */
export const skippedText = (skipped: SkippedManifest): string => `${skippedNote(skipped)} (${errorText(skipped.code)})`;
export const downgradeQuestion = (info: UpdateInfo, update: AvailableUpdate): string => t("update.downgrade.question", { version: update.version, current: info.currentVersion });
/** Same warning without the question, for installs where the app does not run the downgrade itself. */
export const downgradeWarning = (info: UpdateInfo, update: AvailableUpdate): string => t("update.downgrade.warning", { version: update.version, current: info.currentVersion });

const copyField = (p: UpdateDialogViewProps, text: string) => <div className="update-copy">
  <code>{text}</code>
  <button type="button" onClick={() => p.onCopy(text)}>{t("update.copy")}</button>
</div>;

const inlineView = (inlines: Inline[]) => inlines.map((part, i) =>
  part.type === "code" ? <code key={i}>{part.text}</code> : part.type === "bold" ? <strong key={i}>{part.text}</strong> : part.text);

const itemsView = (items: ListItem[]) => <ul>{items.map((item, i) => <li key={i}>
  {inlineView(item.inlines)}
  {item.children.length > 0 && itemsView(item.children)}
</li>)}</ul>;

/** Release notes as elements; a plain function (not a component) so the tree stays inspectable. */
export function notesView(notes: string) {
  return parseNotes(notes).map((block, i) => {
    if (block.type === "heading") { const Tag = block.level <= 3 ? "h4" : "h5"; return <Tag key={i}>{inlineView(block.inlines)}</Tag>; }
    if (block.type === "list") return <div key={i}>{itemsView(block.items)}</div>;
    return <p key={i}>{inlineView(block.inlines)}</p>;
  });
}

/** apt steps for a .deb install (test distribution on or off); the app only shows and copies the commands. */
function aptGuide(p: UpdateDialogViewProps, hint: Exclude<AptHint, { kind: "upgrade" }>) {
  return <>
    <p className="update-note">{t(hint.kind === "enableTest" ? "update.apt.test.intro" : "update.apt.stable.intro")}</p>
    <ol className="update-steps">{hint.steps.map(step => <li key={step.labelKey}>
      <span>{t(step.labelKey, { file: aptSourcesFile })}</span> <code>{step.code}</code>
    </li>)}</ol>
    {hint.command
      ? <><p className="update-note">{t("update.apt.oneLiner")}</p>{copyField(p, hint.command)}</>
      : <p className="update-warning">{t("update.apt.noVersion")}</p>}
    {hint.kind === "leaveTest" && <><p className="update-note">{t("update.apt.policy")}</p><p className="update-note">{t("update.apt.downgradeConfirm")}</p></>}
    <p className="update-note">{aptRepoNote()}</p>
  </>;
}

function aptOffer(p: UpdateDialogViewProps, info: UpdateInfo, update: AvailableUpdate) {
  const hint = aptHint(info, update);
  if (hint && hint.kind !== "upgrade") return aptGuide(p, hint);
  return <><p className="update-note">{aptNote()}</p>{copyField(p, aptCommand)}<p className="update-note">{aptRepoNote()}</p></>;
}

function details(info: UpdateInfo) {
  return <p className="update-meta">{t("update.installed", { version: info.currentVersion, kind: installKindLabel(info.installKind) })}{info.channel === "test" ? ` · ${t("update.channel.test")}` : ""}</p>;
}

function offer(p: UpdateDialogViewProps, info: UpdateInfo, update: AvailableUpdate) {
  const action = updateAction(info);
  const date = formatPubDate(update.pubDate);
  return <>
    <p role="status" className="update-headline">{t(update.downgrade ? "update.downgrade.available" : "update.available", { version: update.version })}</p>
    {/* Back from a test build: the install button itself is the confirmation and says so. */}
    {update.downgrade && <p role="alert" className="update-warning">{action === "install" ? downgradeQuestion(info, update) : downgradeWarning(info, update)}</p>}
    {date && <p className="update-meta">{t("update.published", { date })}</p>}
    {update.skipped && <p className="update-warning">{skippedText(update.skipped)}</p>}
    {update.notes && <>
      <h3 id="update-notes-title">{t("update.notes")}</h3>
      {/* Server text: parsed into React elements (text children only, no links), scrollable via keyboard. */}
      <div className="update-notes" role="region" tabIndex={0} aria-labelledby="update-notes-title">{notesView(update.notes)}</div>
    </>}
    {action === "install" && restartHints(info.installKind).map(hint => <p key={hint} className="update-note">{hint}</p>)}
    {action === "blocked" && <><p className="update-note">{info.blockedReason?.trim() ? errorText(info.blockedReason.trim()) : blockedFallback()}</p><p className="update-note">{downloadNote()}</p>{copyField(p, updateDownloadUrl)}</>}
    {action === "apt" && aptOffer(p, info, update)}
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
    {state.phase === "current" && <><p role="status" className="update-headline">{t("update.current", { version: state.info.currentVersion })}</p>{state.skipped && <p role="alert" className="update-warning">{skippedText(state.skipped)}</p>}{details(state.info)}</>}
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
      {canInstall && <button type="submit" data-initial-focus="" onClick={p.onInstall}>{state.update.downgrade ? t("update.downgrade.confirm") : t("update.install")}</button>}
      {state.phase === "error" && <button type="submit" data-initial-focus="" onClick={p.onRetry}>{t("update.retry")}</button>}
    </div>
  </dialog>;
}
