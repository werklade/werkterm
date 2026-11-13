import { useModal } from "./useModal";
import { tp, useT } from "../i18n";

/** Asked only before an update install: running file transfers end with the restart. */
export function UpdateTransfersDialog({ count, onAnswer }: { count: number; onAnswer(accepted: boolean): void }) {
  const modal = useModal();
  const t = useT();
  return <dialog ref={modal} className="ssh-dialog" aria-modal="true" aria-labelledby="update-transfers-title" onCancel={event => { event.preventDefault(); onAnswer(false); }}>
    <h2 id="update-transfers-title">{t("transfer.updateTitle")}</h2>
    <p>{tp("transfer.running", count)}</p>
    <div className="dialog-actions">
      <button type="button" onClick={() => onAnswer(false)} autoFocus>{t("common.cancel")}</button>
      <button type="submit" onClick={() => onAnswer(true)}>{t("transfer.install")}</button>
    </div>
  </dialog>;
}
