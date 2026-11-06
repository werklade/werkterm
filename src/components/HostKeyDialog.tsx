import type { SshPrompt } from "../lib/ssh";
import { useModal } from "./useModal";

interface Props {
  prompt: Extract<SshPrompt, { type: "hostKey" }>;
  onAnswer: (accept: boolean) => void;
}

export function HostKeyDialog({ prompt, onAnswer }: Props) {
  const dialog = useModal();
  return <dialog ref={dialog} className="ssh-dialog" role="dialog" aria-modal="true" aria-labelledby="hostkey-title" onCancel={event => { event.preventDefault(); onAnswer(false); }}>
    <form onSubmit={event => { event.preventDefault(); onAnswer(true); }}>
      <h2 id="hostkey-title">Unbekannter Host {prompt.host}:{prompt.port}</h2>
      <p>Schlüsseltyp: {prompt.keyType}</p>
      <p>Fingerprint:</p>
      <code className="hostkey-fingerprint" tabIndex={0}>{prompt.fingerprint}</code>
      <div className="dialog-actions">
        <button type="submit" autoFocus>Vertrauen und verbinden</button>
        <button type="button" onClick={() => onAnswer(false)}>Abbrechen</button>
      </div>
    </form>
  </dialog>;
}
