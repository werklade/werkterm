import { useState } from "react";
import { useModal } from "./useModal";
export function SessionUserDialog({ name, onAnswer }: { name: string; onAnswer: (user: string | null) => void }) {
  const dialog = useModal();
  const [user, setUser] = useState("");
  const valid = user.length > 0 && !/[\s@]/.test(user);
  return <dialog ref={dialog} className="ssh-dialog" aria-modal="true" aria-labelledby="session-user-title" onCancel={event => { event.preventDefault(); onAnswer(null); }}><form onSubmit={event => { event.preventDefault(); if (valid) onAnswer(user); }}><h2 id="session-user-title">Benutzername für {name}</h2><input autoFocus aria-label="Benutzername" autoComplete="username" value={user} onChange={event => setUser(event.target.value)} /><div className="dialog-actions"><button type="submit" disabled={!valid}>Verbinden</button><button type="button" onClick={() => onAnswer(null)}>Abbrechen</button></div></form></dialog>;
}
