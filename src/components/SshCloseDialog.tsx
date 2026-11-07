import { useState } from "react";
import { useModal } from "./useModal";
export function SshCloseDialog({ message, transfers, quitting, onAnswer }: { message: string; transfers: number; quitting: boolean; onAnswer(accepted: boolean, never: boolean): void }) {
  const modal = useModal();
  const [never, setNever] = useState(false);
  return <dialog ref={modal} className="ssh-dialog" aria-modal="true" aria-labelledby="ssh-close-title" onCancel={event => { event.preventDefault(); onAnswer(false, false); }}>
    <h2 id="ssh-close-title">{quitting ? "Beenden?" : "Verbindung trennen?"}</h2><p>{message}</p>
    {transfers > 0 && <p>{transfers} Transfer(s) laufen und werden abgebrochen.</p>}
    <label><input type="checkbox" checked={never} onChange={event => setNever(event.target.checked)} />Nicht mehr fragen</label>
    <div className="dialog-actions"><button onClick={() => onAnswer(true, never)}>{quitting ? "Beenden" : "Trennen"}</button><button autoFocus onClick={() => onAnswer(false, never)}>Abbrechen</button></div>
  </dialog>;
}
