import { useState } from "react";
import { tp, useT } from "../i18n";
import { useModal } from "./useModal";
export function SshCloseDialog({ message, transfers, quitting, onAnswer }: { message: string; transfers: number; quitting: boolean; onAnswer(accepted: boolean, never: boolean): void }) {
  const t = useT();
  const modal = useModal();
  const [never, setNever] = useState(false);
  return <dialog ref={modal} className="ssh-dialog" aria-modal="true" aria-labelledby="ssh-close-title" onCancel={event => { event.preventDefault(); onAnswer(false, false); }}>
    <h2 id="ssh-close-title">{quitting ? t("ssh.close.quitTitle") : t("ssh.close.title")}</h2><p>{message}</p>
    {transfers > 0 && <p>{tp("ssh.close.transfers", transfers)}</p>}
    <label><input type="checkbox" checked={never} onChange={event => setNever(event.target.checked)} />{t("ssh.close.never")}</label>
    <div className="dialog-actions"><button onClick={() => onAnswer(true, never)}>{quitting ? t("ssh.close.quit") : t("ssh.close.disconnect")}</button><button autoFocus onClick={() => onAnswer(false, never)}>{t("common.cancel")}</button></div>
  </dialog>;
}
