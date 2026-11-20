import { useId, useState, type KeyboardEvent } from "react";
import { useModal } from "./useModal";
import { availableScopes, effectiveScope, hasPasteControls, singleLinePaste, stripLastNewline, type PasteChoice, type RememberScope } from "../lib/paste";
import { tp, useT } from "../i18n";
export interface PasteRememberRequest { scope: Exclude<RememberScope, "none">; choice: PasteChoice }
export function PasteDialog({ text, count, multiExec, hasProfile, onAnswer }: { text: string; count: number; multiExec: boolean; hasProfile: boolean; onAnswer(text: string | null, remember?: PasteRememberRequest | null): void }) {
  const t = useT();
  const dialog = useModal();
  const rememberId = useId();
  const [draft, setDraft] = useState(text);
  const [trim, setTrim] = useState(true);
  const [scope, setScope] = useState<RememberScope>("none");
  const controls = hasPasteControls(text) || hasPasteControls(draft);
  const available = availableScopes({ controls, multiExec, hasProfile });
  const active = effectiveScope(scope, available);
  const send = (single: boolean) => {
    const value = trim ? stripLastNewline(draft) : draft;
    onAnswer(single ? singleLinePaste(value) : value, active === "none" ? null : { scope: active, choice: { action: single ? "single-line" : "paste", trim } });
  };
  const hintId = `${rememberId}-hint`;
  // Enter confirms unless focus sits in a control with its own Enter behaviour (textarea, checkbox, select, other buttons).
  // preventDefault keeps the key from becoming a keypress in the terminal that regains focus when the dialog closes.
  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== "Enter" || e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const target = e.target as HTMLElement;
    if (target !== e.currentTarget && !target.hasAttribute("data-paste-confirm")) return;
    e.preventDefault(); e.stopPropagation(); send(false);
  };
  return <dialog ref={dialog} className="ssh-dialog paste-dialog" aria-label={t("paste.title")} onKeyDown={onKeyDown} onCancel={e => { e.preventDefault(); onAnswer(null); }}>
    <h2>{t("paste.title")}</h2>{multiExec && <p>{tp("paste.sendTo", count)}</p>}
    <textarea aria-label={t("paste.textLabel")} spellCheck={false} value={draft} onChange={e => setDraft(e.target.value)} />
    <p>{tp("paste.lines", draft.split(/\r\n|\r|\n/).length)} · {tp("paste.chars", draft.length)}</p>
    {hasPasteControls(draft) && <p role="alert">{t("paste.controlWarning")}</p>}
    <label><input type="checkbox" checked={trim} onChange={e => setTrim(e.target.checked)} />{t("paste.trim")}</label>
    <div className="dialog-actions paste-actions">
      <label className="paste-remember" htmlFor={rememberId}>{t("paste.remember")}
        <select id={rememberId} value={active} disabled={controls} aria-describedby={controls ? hintId : undefined} onChange={e => setScope(e.target.value as RememberScope)}>
          <option value="none">{t("paste.rememberNone")}</option>
          <option value="tab" disabled={!available.tab}>{t("paste.rememberTab")}</option>
          <option value="profile" disabled={!available.profile}>{!hasProfile && !multiExec ? t("paste.rememberNoProfile") : t("paste.rememberProfile")}</option>
          <option value="global">{t("paste.rememberGlobal")}</option>
        </select>
      </label>
      {controls && <small id={hintId} className="paste-remember-hint">{t("paste.controlsHint")}</small>}
      <button autoFocus data-autofocus data-paste-confirm onClick={() => send(false)}>{t("paste.confirm")}</button><button onClick={() => send(true)}>{t("paste.singleLine")}</button><button onClick={() => onAnswer(null)}>{t("common.cancel")}</button>
    </div>
  </dialog>;
}
