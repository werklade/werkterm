import { usePasswordInput } from "../lib/passwordInput";
import { PasswordField } from "./PasswordField";
import type { SshPrompt } from "../lib/ssh";
import { useModal } from "./useModal";

interface Props {
  prompt: Extract<SshPrompt, { type: "secret" }>;
  title?: string;
  onAnswer: (secret: string | null) => void;
}

export function SecretDialog({ prompt, onAnswer, title }: Props) {
  const dialog = useModal();
  const secret = usePasswordInput();
  const cancel = () => { secret.reset(); onAnswer(null); };
  const label = title ?? `${prompt.kind === "password" ? "Passwort" : "Passphrase"} für ${prompt.label}`;
  return <dialog ref={dialog} className="ssh-dialog" role="dialog" aria-modal="true" aria-labelledby="secret-title" onCancel={event => { event.preventDefault(); cancel(); }}>
    <form autoComplete="off" onSubmit={event => {
      event.preventDefault();
      const value = secret.value;
      secret.reset();
      if (dialog.current) {
        const input = dialog.current.querySelector("input");
        if (input) input.value = "";
      }
      onAnswer(value);
    }}>
      <h2 id="secret-title">{label}</h2>
      <PasswordField autoFocus autoComplete="off" aria-label={label} value={secret.value} visible={secret.visible} onToggle={secret.toggle} onChange={event => secret.change(event.target.value)} />
      <div className="dialog-actions">
        <button type="submit">OK</button>
        <button type="button" onClick={cancel}>Abbrechen</button>
      </div>
    </form>
  </dialog>;
}
