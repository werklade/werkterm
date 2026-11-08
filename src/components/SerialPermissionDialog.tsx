import { writeClipboardText } from "../lib/clipboard";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useModal } from "./useModal";
import { permissionMode, type SerialPermission, type FixOptions } from "../lib/serialPermission";

interface Props {
  info: SerialPermission;
  onClose(): void;
  onRetry(): void;
  onExecute(command: string): Promise<void>;
}
export function SerialPermissionDialog({ info, onClose, onRetry, onExecute }: Props) {
  const dialog = useModal();
  const [fixes, setFixes] = useState<FixOptions | null>(null);
  const [selected, setSelected] = useState(0);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    // Release modal focus so the user can enter the password in the new terminal.
    element.close();
    if (sent) element.show();
    else if (!busy) element.showModal();
  }, [busy, sent, dialog]);
  useEffect(() => {
    let disposed = false;
    if (!info.already_member) void invoke<FixOptions>("serial_permission_fix_options", { device: info.device })
      .then(value => { if (!disposed) setFixes(value); })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [info]);
  const mode = permissionMode(info, fixes);
  const option = fixes?.options[selected];
  const copy = (text: string) => { void writeClipboardText(text).catch(reason => setError(String(reason))); };
  const newgrp = "newgrp " + "'" + info.group.split("'").join(String.fromCharCode(39, 34, 39, 34, 39)) + "'";
  return <dialog ref={dialog} className="ssh-dialog" aria-labelledby="serial-permission-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="serial-permission-title">Keine Berechtigung für {info.device}</h2>
    {mode === "member" ? <p>Du bist bereits in der Gruppe {info.group}, die Änderung wirkt aber erst nach Ab- und Anmelden. Sofort in einer Shell: <code>{newgrp}</code></p> : <>
      <p>Benutzer {info.username} zur Gruppe {info.group} hinzufügen?</p>
      {info.guessed && <p>Die Gerätegruppe konnte nicht ermittelt werden. „dialout“ ist eine Vermutung; bitte vor der Ausführung prüfen.</p>}
      {mode === "loading" && !error && <p>Verfügbare Werkzeuge werden geprüft…</p>}
      {mode === "options" && option && <>
        <label>Befehl <select value={selected} disabled={busy || sent} onChange={event => setSelected(Number(event.target.value))}>
          {fixes!.options.map((item, index) => <option key={item.label} value={index}>{item.label}{index === 0 ? " (empfohlen)" : ""}</option>)}
        </select></label>
        <textarea aria-label="Vollständiger Befehl" readOnly value={option.command} rows={3} style={{ width: "100%", fontFamily: "monospace" }} />
        <p>{option.needs_root_password ? "fragt das Root-Passwort" : option.hint}</p>
        {!sent && <button disabled={busy} onClick={() => {
          setBusy(true); setError("");
          void onExecute(option.command).then(() => setSent(true)).catch(reason => setError(String(reason))).finally(() => setBusy(false));
        }}>Im lokalen Terminal ausführen</button>}
        <button onClick={() => copy(option.command)}>Befehl kopieren</button>
      </>}
      {mode === "missing" && fixes && <>
        <p>Fehlende Werkzeuge: {fixes.missing.join(", ")}</p>
        <p>Installation als root: {fixes.install_hint}</p>
        <p>Als root ausführen:</p>
        <textarea aria-label="Root-Befehl" readOnly value={fixes.root_command} rows={3} style={{ width: "100%", fontFamily: "monospace" }} />
        <button onClick={() => copy(fixes.root_command)}>Befehl kopieren</button>
      </>}
      {sent && <p>Nach Ab- und Anmelden wirksam (oder <code>{newgrp}</code>). Passworteingabe im lokalen Terminal.</p>}
    </>}
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions">
      {(mode === "member" || sent) && <button onClick={onRetry}>Erneut verbinden</button>}
      <button disabled={busy} onClick={onClose}>{mode === "member" || sent ? "Schließen" : "Abbrechen"}</button>
    </div>
  </dialog>;
}
