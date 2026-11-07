import { useState } from "react";
import { useModal } from "./useModal";
import { hasPasteControls, singleLinePaste, stripLastNewline } from "../lib/paste";
export function PasteDialog({ text, count, multiExec, onAnswer }: { text: string; count: number; multiExec: boolean; onAnswer(text: string | null): void }) {
  const dialog = useModal();
  const [draft, setDraft] = useState(text);
  const [trim, setTrim] = useState(true);
  const send = (single: boolean) => { const value = trim ? stripLastNewline(draft) : draft; onAnswer(single ? singleLinePaste(value) : value); };
  return <dialog ref={dialog} className="ssh-dialog paste-dialog" aria-label="Einfügen bestätigen" onCancel={e => { e.preventDefault(); onAnswer(null); }}>
    <h2>Einfügen bestätigen</h2>{multiExec && <p>Geht an {count} Terminals</p>}
    <textarea aria-label="Einzufügender Text" spellCheck={false} value={draft} onChange={e => setDraft(e.target.value)} />
    <p>{draft.split(/\r\n|\r|\n/).length} Zeilen · {draft.length} Zeichen</p>
    {hasPasteControls(draft) && <p role="alert">Warnung: Der Text enthält ESC oder andere Steuerzeichen.</p>}
    <label><input type="checkbox" checked={trim} onChange={e => setTrim(e.target.checked)} />Letzten Zeilenumbruch entfernen</label>
    <div className="dialog-actions"><button autoFocus onClick={() => send(false)}>Einfügen</button><button onClick={() => send(true)}>Als eine Zeile</button><button onClick={() => onAnswer(null)}>Abbrechen</button></div>
  </dialog>;
}
