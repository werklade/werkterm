import { useState } from "react";
import { useT } from "../i18n";
import { useModal } from "./useModal";
export function SessionUserDialog({ name, onAnswer }: { name: string; onAnswer: (user: string | null) => void }) {
  const t = useT();
  const dialog = useModal();
  const [user, setUser] = useState("");
  const valid = user.length > 0 && !/[\s@]/.test(user);
  return <dialog ref={dialog} className="ssh-dialog" aria-modal="true" aria-labelledby="session-user-title" onCancel={event => { event.preventDefault(); onAnswer(null); }}><form onSubmit={event => { event.preventDefault(); if (valid) onAnswer(user); }}><h2 id="session-user-title">{t("session.userDialog.title", { name })}</h2><input autoFocus aria-label={t("session.userDialog.label")} autoComplete="username" value={user} onChange={event => setUser(event.target.value)} /><div className="dialog-actions"><button type="submit" disabled={!valid}>{t("session.connect")}</button><button type="button" onClick={() => onAnswer(null)}>{t("common.cancel")}</button></div></form></dialog>;
}
