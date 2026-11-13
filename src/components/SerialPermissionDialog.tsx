import { writeClipboardText } from "../lib/clipboard";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useModal } from "./useModal";
import { useT } from "../i18n";
import { permissionMode, type SerialPermission, type FixOptions } from "../lib/serialPermission";

interface Props {
  info: SerialPermission;
  onClose(): void;
  onRetry(): void;
  onExecute(command: string): Promise<void>;
}
export function SerialPermissionDialog({ info, onClose, onRetry, onExecute }: Props) {
  const t = useT();
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
    <h2 id="serial-permission-title">{t("serial.title", { device: info.device })}</h2>
    {mode === "member" ? <p>{t("serial.member", { group: info.group })} <code>{newgrp}</code></p> : <>
      <p>{t("serial.add", { username: info.username, group: info.group })}</p>
      {info.guessed && <p>{t("serial.guessed")}</p>}
      {mode === "loading" && !error && <p>{t("serial.checking")}</p>}
      {mode === "options" && option && <>
        <label>{t("serial.command")} <select value={selected} disabled={busy || sent} onChange={event => setSelected(Number(event.target.value))}>
          {fixes!.options.map((item, index) => <option key={item.label} value={index}>{item.label}{index === 0 ? ` ${t("serial.recommended")}` : ""}</option>)}
        </select></label>
        <textarea aria-label={t("serial.fullCommand")} readOnly value={option.command} rows={3} style={{ width: "100%", fontFamily: "monospace" }} />
        <p>{option.needs_root_password ? t("serial.asksRoot") : option.hint}</p>
        {!sent && <button disabled={busy} onClick={() => {
          setBusy(true); setError("");
          void onExecute(option.command).then(() => setSent(true)).catch(reason => setError(String(reason))).finally(() => setBusy(false));
        }}>{t("serial.run")}</button>}
        <button onClick={() => copy(option.command)}>{t("serial.copyCommand")}</button>
      </>}
      {mode === "missing" && fixes && <>
        <p>{t("serial.missing", { tools: fixes.missing.join(", ") })}</p>
        <p>{t("serial.install", { hint: fixes.install_hint })}</p>
        <p>{t("serial.runAsRoot")}</p>
        <textarea aria-label={t("serial.rootCommand")} readOnly value={fixes.root_command} rows={3} style={{ width: "100%", fontFamily: "monospace" }} />
        <button onClick={() => copy(fixes.root_command)}>{t("serial.copyCommand")}</button>
      </>}
      {sent && <><p>{t("serial.sent")} <code>{newgrp}</code></p><p>{t("serial.sentPassword")}</p></>}
    </>}
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions">
      {(mode === "member" || sent) && <button onClick={onRetry}>{t("serial.retry")}</button>}
      <button disabled={busy} onClick={onClose}>{mode === "member" || sent ? t("common.close") : t("common.cancel")}</button>
    </div>
  </dialog>;
}
