import { useState } from "react";
import { validRemoteName } from "../lib/transfers";
import { useModal } from "./useModal";

export type ConflictAnswer = "overwrite" | "skip" | "all" | "cancel";
export type FileDialog =
  | { type: "name"; directory: boolean; answer: (name: string | null) => void }
  | { type: "delete"; message: string; confirmLabel?: string; answer: (accepted: boolean) => void }
  | { type: "conflict"; name: string; answer: (answer: ConflictAnswer) => void };

export function FileActionDialog({ prompt }: { prompt: FileDialog }) {
  const dialog = useModal();
  const [name, setName] = useState("");
  const cancel = () => {
    if (prompt.type === "name") prompt.answer(null);
    else if (prompt.type === "delete") prompt.answer(false);
    else prompt.answer("cancel");
  };
  const title = prompt.type === "name" ? (prompt.directory ? "Neuer Ordner" : "Neue Datei")
    : prompt.type === "delete" ? prompt.message : `Datei existiert bereits: ${prompt.name}. Überschreiben?`;
  return <dialog ref={dialog} className="ssh-dialog file-action-dialog" aria-modal="true" aria-labelledby="file-action-title" onCancel={event => { event.preventDefault(); cancel(); }}>
    <form onSubmit={event => { event.preventDefault(); if (prompt.type === "name" && validRemoteName(name)) prompt.answer(name); }}>
      <h2 id="file-action-title">{title}</h2>
      {prompt.type === "name" && <><input autoFocus aria-label="Name" value={name} onChange={event => setName(event.target.value)} aria-invalid={name.length > 0 && !validRemoteName(name)} />{name.length > 0 && !validRemoteName(name) && <p role="alert">Ungültiger Name</p>}</>}
      <div className="dialog-actions">
        {prompt.type === "name" && <button type="submit" disabled={!validRemoteName(name)}>Erstellen</button>}
        {prompt.type === "delete" && <button type="button" onClick={() => prompt.answer(true)}>{prompt.confirmLabel ?? "Endgültig löschen"}</button>}
        {prompt.type === "conflict" && <><button type="button" onClick={() => prompt.answer("overwrite")}>Überschreiben</button><button type="button" onClick={() => prompt.answer("skip")}>Überspringen</button><button type="button" onClick={() => prompt.answer("all")}>Alle überschreiben</button></>}
        <button autoFocus={prompt.type !== "name"} type="button" onClick={cancel}>Abbrechen</button>
      </div>
    </form>
  </dialog>;
}
