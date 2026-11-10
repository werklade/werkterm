import { useId, useState } from "react";
import { useModal } from "./useModal";
import { availableScopes, effectiveScope, hasPasteControls, singleLinePaste, stripLastNewline, type PasteChoice, type RememberScope } from "../lib/paste";
export interface PasteRememberRequest { scope: Exclude<RememberScope, "none">; choice: PasteChoice }
export function PasteDialog({ text, count, multiExec, hasProfile, onAnswer }: { text: string; count: number; multiExec: boolean; hasProfile: boolean; onAnswer(text: string | null, remember?: PasteRememberRequest | null): void }) {
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
  return <dialog ref={dialog} className="ssh-dialog paste-dialog" aria-label="Einfügen bestätigen" onCancel={e => { e.preventDefault(); onAnswer(null); }}>
    <h2>Einfügen bestätigen</h2>{multiExec && <p>Geht an {count} Terminals</p>}
    <textarea aria-label="Einzufügender Text" spellCheck={false} value={draft} onChange={e => setDraft(e.target.value)} />
    <p>{draft.split(/\r\n|\r|\n/).length} Zeilen · {draft.length} Zeichen</p>
    {hasPasteControls(draft) && <p role="alert">Warnung: Der Text enthält ESC oder andere Steuerzeichen.</p>}
    <label><input type="checkbox" checked={trim} onChange={e => setTrim(e.target.checked)} />Letzten Zeilenumbruch entfernen</label>
    <div className="dialog-actions paste-actions">
      <label className="paste-remember" htmlFor={rememberId}>Auswahl merken?
        <select id={rememberId} value={active} disabled={controls} aria-describedby={controls ? hintId : undefined} onChange={e => setScope(e.target.value as RememberScope)}>
          <option value="none">Nicht merken</option>
          <option value="tab" disabled={!available.tab}>Für diesen Tab merken</option>
          <option value="profile" disabled={!available.profile}>{!hasProfile && !multiExec ? "Für das Profil merken (kein Profil)" : "Für das Profil merken"}</option>
          <option value="global">Dauerhaft merken</option>
        </select>
      </label>
      {controls && <small id={hintId} className="paste-remember-hint">Bei Steuerzeichen wird immer gefragt</small>}
      <button autoFocus onClick={() => send(false)}>Einfügen</button><button onClick={() => send(true)}>Als eine Zeile</button><button onClick={() => onAnswer(null)}>Abbrechen</button>
    </div>
  </dialog>;
}
