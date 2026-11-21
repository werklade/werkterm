import { keyringErrorText } from "../lib/keyringErrors";
import { errorText } from "../lib/backendError";
import { invoke } from "@tauri-apps/api/core";
import { defaultSerial, sshOptionsError, validateSession, type SerialConfig } from "../lib/sessions";
import { legacySshAlgorithms, sshOptionsOverrideKeepalive } from "../lib/sshOptions";
import { useEffect, useId, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { initialSessionAuthType, jumpHostOptions, sessionLabel, keyringAvailable, saveSession, type SavedSession, type SessionAuth } from "../lib/sessions";
import { useT } from "../i18n";
import { describeChoice, type PasteChoice } from "../lib/paste";
import { useModal } from "./useModal";
import { PasswordField } from "./PasswordField";
import { usePasswordInput } from "../lib/passwordInput";
import "./SessionDialog.css";

interface Props {
  session?: SavedSession;
  preferPassword?: boolean;
  sessions: SavedSession[];
  onClose: () => void;
  onSaved: (session: SavedSession) => void;
  /** Paste choice remembered for this saved session; the reset line is only shown when one exists. */
  rememberedPaste?: PasteChoice | null;
  /** Forgets the remembered paste choice right away (not on save). */
  onResetPaste?: () => void;
}

const standardBauds = [300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
export function SessionDialog({ session, preferPassword = false, sessions, onClose, onSaved, rememberedPaste, onResetPaste }: Props) {
  const t = useT();
  const dialog = useModal();
  const id = useId();
  const [kind, setKind] = useState(session?.kind ?? "ssh");
  const [serial, setSerial] = useState<SerialConfig>(session?.serial ?? { ...defaultSerial });
  const [baudCustom, setBaudCustom] = useState(() => !standardBauds.includes(serial.baud));
  const [ports, setPorts] = useState<{ name: string; description: string }[]>([]);
  const refreshPorts = () => { void invoke<{ name: string; description: string }[]>("serial_ports").then(setPorts, reason => setError(errorText(reason))); };
  useEffect(() => { if (kind === "serial") refreshPorts(); }, [kind]);
  const [logAlways, setLogAlways] = useState(session?.log_always ?? false);
  const [name, setName] = useState(session?.name ?? "");
  const [folder, setFolder] = useState(session?.folder ?? "");
  const [host, setHost] = useState(session?.host ?? "");
  const [keepaliveInterval, setKeepaliveInterval] = useState(session?.keepaliveInterval ?? 30);
  const [jumpSessionId, setJumpSessionId] = useState(session?.jumpSessionId ?? "");
  const jumpOptions = jumpHostOptions(sessions, session?.id);
  const [keepaliveMax, setKeepaliveMax] = useState(session?.keepaliveMax ?? 3);
  const [sshOptions, setSshOptions] = useState(session?.sshOptions ?? "");
  const sshOptionsProblem = kind === "ssh" ? sshOptionsError(sshOptions) : null;
  const legacyAlgorithms = kind === "ssh" && !sshOptionsProblem ? legacySshAlgorithms(sshOptions) : [];
  const [port, setPort] = useState(String(session?.port ?? 22));
  const [user, setUser] = useState(session?.user ?? "");
  const [authType, setAuthType] = useState<SessionAuth["type"]>(() => initialSessionAuthType(session, preferPassword, false));
  const authChanged = useRef(false);
  const [keyPath, setKeyPath] = useState(session?.auth.type === "keyFile" ? session.auth.path : "");
  const password = usePasswordInput();
  const [keyring, setKeyring] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Only keeps the line visible after a reset; text and button state follow the prop (settings may reload meanwhile).
  const [pasteReset, setPasteReset] = useState(false);
  const pasteStatus = useRef<HTMLSpanElement>(null);
  const showPaste = Boolean(session?.id && onResetPaste && (rememberedPaste || pasteReset));
  useEffect(() => {
    let active = true;
    const resolve = (value: boolean) => {
      if (!active) return;
      setKeyring(value);
      if (!authChanged.current) setAuthType(initialSessionAuthType(session, preferPassword, value));
    };
    void keyringAvailable().then(resolve, () => {
      if (!active) return;
      resolve(false);
    });
    return () => { active = false; };
  }, [session, preferPassword]);
  const folders = new Set<string>();
  for (const saved of sessions) {
    const parts = saved.folder.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const draft: SavedSession = { kind, id: session?.id ?? "", name: name.trim(), folder: folder.trim(), host: kind === "serial" ? "" : host,
    port: kind === "serial" ? 23 : Number(port), user: user.trim() || null, serial: kind === "serial" ? serial : null,
    keepaliveInterval: kind === "ssh" ? keepaliveInterval : 30, keepaliveMax: kind === "ssh" ? keepaliveMax : 3,
    jumpSessionId: kind === "ssh" ? jumpSessionId || null : null, log_always: logAlways, sshOptions: kind === "ssh" && sshOptions.trim() ? sshOptions : "",
    auth: kind !== "ssh" ? { type: "default" } : authType === "keyFile" ? { type: "keyFile", path: keyPath } : { type: authType }, source: session?.source ?? null };
  const valid = validateSession(draft) === null && (kind !== "ssh" || !jumpSessionId || jumpOptions.some(hop => hop.id === jumpSessionId));
  const clearPassword = () => {
    password.reset();
    const input = dialog.current?.querySelector<HTMLInputElement>('.password-field input');
    if (input) input.value = "";
  };
  const cancel = () => { if (!busy) { clearPassword(); onClose(); } };
  const browse = async () => {
    try {
      const path = await open({ directory: false, multiple: false, title: t("session.keyFile.dialogTitle") });
      if (typeof path === "string") setKeyPath(path);
    } catch { setError(t("session.keyFile.pickFailed")); }
  };
  return <dialog ref={dialog} className="ssh-dialog session-dialog" aria-modal="true" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); cancel(); }}>
    <form autoComplete="off" onSubmit={event => {
      event.preventDefault();
      if (!valid || busy) return;
      const secret = kind === "ssh" && authType === "password" && password.value !== "" ? password.value : null;
      clearPassword();
      setBusy(true); setError("");
      void saveSession(draft, secret).then(onSaved, reason => {
        setError(sessionSaveError(reason));
        setBusy(false);
      });
    }}>
      <h2 id={`${id}-title`}>{session?.id ? t("session.title.edit") : t("session.title.new")}</h2>
      <fieldset disabled={busy} className="session-fields">
        <label>{t("session.kind")}<select value={kind} onChange={event => { const next = event.target.value; setKind(next); setPort(next === "telnet" ? "23" : "22"); clearPassword(); }}><option value="ssh">{t("session.kind.ssh")}</option><option value="telnet">{t("session.kind.telnet")}</option><option value="serial">{t("session.kind.serial")}</option></select></label>
        <label>{t("session.name")}<input autoFocus required value={name} onChange={event => setName(event.target.value)} /></label>
        <label>{t("session.folder")}<input list={`${id}-folders`} value={folder} onChange={event => setFolder(event.target.value)} placeholder={t("session.folder.placeholder")} /></label>
        <datalist id={`${id}-folders`}>{[...folders].sort().map(path => <option key={path} value={path} />)}</datalist>
        {kind !== "serial" && <><div className="session-target-fields"><label>{t("session.host")}<input required value={host} onChange={event => setHost(event.target.value)} /></label>
          <label>{t("session.port")}<input required type="number" min="1" max="65535" value={port} onChange={event => setPort(event.target.value)} /></label></div>
        <label>{t("session.user")}<input value={user} onChange={event => setUser(event.target.value)} placeholder={t("session.user.placeholder")} /></label>
        </>}
        {kind === "telnet" && <p role="note" className="session-hint">{t("session.telnetWarning")}</p>}
        {kind === "serial" && <>
          <label>{t("session.port")}<div className="session-path-field"><input required list={`${id}-ports`} value={serial.device} placeholder={t("session.serial.device.placeholder")} onChange={e => setSerial({ ...serial, device: e.target.value })}/><button type="button" onClick={refreshPorts}>{t("session.refresh")}</button></div></label>
          <datalist id={`${id}-ports`}>{ports.map(port => <option key={port.name} value={port.name}>{port.description || t("serial.unknownType")}</option>)}</datalist>
          <label>{t("session.baud")}<select value={baudCustom ? "custom" : String(serial.baud)} onChange={e => { const custom = e.target.value === "custom"; setBaudCustom(custom); if (!custom) setSerial({ ...serial, baud: Number(e.target.value) }); }}>
            {standardBauds.map(n => <option key={n} value={n}>{n}</option>)}<option value="custom">{t("session.baud.otherRate")}</option></select></label>
          {baudCustom && <label>{t("session.baud.custom")}<input required type="number" min={1} max={4294967295} value={serial.baud} onChange={e => setSerial({ ...serial, baud: Number(e.target.value) })}/></label>}
          <label>{t("session.dataBits")}<select value={serial.data_bits} onChange={e => setSerial({ ...serial, data_bits: Number(e.target.value) })}>{[5,6,7,8].map(n => <option key={n}>{n}</option>)}</select></label>
          <label>{t("session.parity")}<select value={serial.parity} onChange={e => setSerial({ ...serial, parity: e.target.value as SerialConfig["parity"] })}><option value="none">{t("session.parity.none")}</option><option value="odd">{t("session.parity.odd")}</option><option value="even">{t("session.parity.even")}</option></select></label>
          <label>{t("session.stopBits")}<select value={serial.stop_bits} onChange={e => setSerial({ ...serial, stop_bits: Number(e.target.value) })}><option>1</option><option>2</option></select></label>
          <label>{t("session.flow")}<select value={serial.flow} onChange={e => setSerial({ ...serial, flow: e.target.value as SerialConfig["flow"] })}><option value="none">{t("session.flow.none")}</option><option value="software">{t("session.flow.software")}</option><option value="hardware">{t("session.flow.hardware")}</option></select></label>
          <label>{t("session.enter")}<select value={serial.enter} onChange={e => setSerial({ ...serial, enter: e.target.value as SerialConfig["enter"] })}><option value="cr">CR</option><option value="lf">LF</option><option value="crlf">CRLF</option></select></label>
          <label><input type="checkbox" checked={serial.local_echo} onChange={e => setSerial({ ...serial, local_echo: e.target.checked })}/>{t("session.localEcho")}</label>
        </>}
        {kind === "ssh" && <><label>{t("session.auth")}<select value={authType} onChange={event => { authChanged.current = true; setAuthType(event.target.value as SessionAuth["type"]); clearPassword(); }}>
          <option value="default">{t("session.auth.default")}</option><option value="keyFile">{t("session.auth.keyFile")}</option>
          <option value="password" disabled={keyring !== true}>{t("session.auth.password")}</option><option value="ask">{t("session.auth.ask")}</option>
        </select></label>
        {keyring === false && <p className="session-hint">{t("keyring.unavailable")}</p>}
        {authType === "keyFile" && <label>{t("session.keyFile")}<div className="session-path-field"><input required value={keyPath} onChange={event => setKeyPath(event.target.value)} /><button type="button" title={t("session.keyFile.browseTitle")} onClick={() => void browse()}>{t("session.browse")}</button></div></label>}
        {authType === "password" && <label>{t("session.password")}<PasswordField autoComplete="off" disabled={keyring !== true} value={password.value} visible={password.visible} onToggle={password.toggle} onChange={event => password.change(event.target.value)} />
          {session?.id && <span className="session-hint">{t("session.password.keep")}</span>}</label>}
        </>}<details open={session?.sshOptions ? true : undefined}><summary>{t("session.advanced")}</summary><label><input type="checkbox" checked={logAlways} onChange={e => setLogAlways(e.target.checked)} />{t("session.logAlways")}</label>
          {showPaste && <div className="session-paste-remembered"><span role="status" tabIndex={-1} ref={pasteStatus}>{describeChoice(rememberedPaste ?? null)}</span>
            <button type="button" title={t("session.pasteReset.tabHint")} disabled={!rememberedPaste} onClick={() => { setPasteReset(true); onResetPaste?.(); pasteStatus.current?.focus(); }}>{t("session.pasteReset")}</button></div>}
          {kind === "ssh" && <><label>{t("session.jump")}<select value={jumpSessionId} onChange={event => setJumpSessionId(event.target.value)}>
            <option value="">{t("session.jump.none")}</option>
            {jumpOptions.map(hop => <option key={hop.id} value={hop.id}>{hop.name} ({sessionLabel(hop)})</option>)}
          </select></label>
          <small className="session-hint">{t("session.jump.hint")}</small><p>{t("session.keepalive.info")}</p><label>{t("session.keepalive.interval")}<input type="number" required min={0} max={3600} value={keepaliveInterval} onChange={e => setKeepaliveInterval(Number(e.target.value))} /></label><label>{t("session.keepalive.max")}<input type="number" required min={1} max={100} value={keepaliveMax} onChange={e => setKeepaliveMax(Number(e.target.value))} /></label>
          {sshOptionsOverrideKeepalive(sshOptions) && <small className="session-hint">{t("session.keepalive.overridden")}</small>}
          <label>{t("session.sshOptions")}<textarea className="session-ssh-options" rows={3} spellCheck={false} autoCapitalize="off" autoCorrect="off" value={sshOptions} placeholder="KexAlgorithms=+diffie-hellman-group14-sha1" aria-invalid={sshOptionsProblem !== null} onChange={e => setSshOptions(e.target.value)} /></label>
          <small className="session-hint">{t("session.sshOptions.hint")}</small>
          {sshOptionsProblem && <p role="alert" className="session-error">{sshOptionsProblem}</p>}
          {legacyAlgorithms.length > 0 && <p role="note" className="session-warning">{t("session.sshOptions.legacy", { names: legacyAlgorithms.join(", ") })}</p>}</>}</details>
      </fieldset>
      {error && <p role="alert" className="session-error">{error}</p>}
      <div className="dialog-actions"><button type="submit" disabled={!valid || busy}>{busy ? t("session.saving") : t("common.save")}</button><button type="button" disabled={busy} onClick={cancel}>{t("common.cancel")}</button></div>
    </form>
  </dialog>;
}

export function sessionSaveError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return keyringErrorText(message);
}
