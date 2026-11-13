import type { SshPrompt } from "../lib/ssh";
import { useT } from "../i18n";
import { useModal } from "./useModal";

interface Props {
  prompt: Extract<SshPrompt, { type: "hostKey" }>;
  onAnswer: (accept: boolean) => void;
}

export function HostKeyDialog({ prompt, onAnswer }: Props) {
  const t = useT();
  const dialog = useModal();
  return <dialog ref={dialog} className="ssh-dialog" role="dialog" aria-modal="true" aria-labelledby="hostkey-title" onCancel={event => { event.preventDefault(); onAnswer(false); }}>
    <form onSubmit={event => { event.preventDefault(); onAnswer(true); }}>
      <h2 id="hostkey-title">{t("hostKey.title", { host: prompt.host, port: prompt.port })}</h2>
      <p>{t("hostKey.keyType", { type: prompt.keyType })}</p>
      <p>{t("hostKey.fingerprint")}</p>
      <code className="hostkey-fingerprint" tabIndex={0}>{prompt.fingerprint}</code>
      <div className="dialog-actions">
        <button type="submit" autoFocus>{t("hostKey.trust")}</button>
        <button type="button" onClick={() => onAnswer(false)}>{t("common.cancel")}</button>
      </div>
    </form>
  </dialog>;
}
