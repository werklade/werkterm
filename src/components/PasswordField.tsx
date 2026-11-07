import type { ComponentProps } from "react";

export function PasswordField({ visible, onToggle, ...input }: Omit<ComponentProps<"input">, "type"> & {
  visible: boolean;
  onToggle: () => void;
}) {
  return <div className="password-field">
    <input {...input} type={visible ? "text" : "password"} />
    <button className="password-toggle" type="button" disabled={input.disabled} aria-pressed={visible}
      aria-label={visible ? "Passwort verbergen" : "Passwort anzeigen"} onClick={onToggle}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />
        {visible && <path d="m3 3 18 18" />}
      </svg>
    </button>
  </div>;
}
