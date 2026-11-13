import { useModal } from "./useModal";
import { transfersMessage } from "../lib/updateState";

/** Asked only before an update install: running file transfers end with the restart. */
export function UpdateTransfersDialog({ count, onAnswer }: { count: number; onAnswer(accepted: boolean): void }) {
  const modal = useModal();
  return <dialog ref={modal} className="ssh-dialog" aria-modal="true" aria-labelledby="update-transfers-title" onCancel={event => { event.preventDefault(); onAnswer(false); }}>
    <h2 id="update-transfers-title">Update installieren?</h2>
    <p>{transfersMessage(count)}</p>
    <div className="dialog-actions">
      <button type="button" onClick={() => onAnswer(false)} autoFocus>Abbrechen</button>
      <button type="submit" onClick={() => onAnswer(true)}>Installieren</button>
    </div>
  </dialog>;
}
