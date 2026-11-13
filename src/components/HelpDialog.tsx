import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import licenseText from "../../LICENSE?raw";
import { useModal } from "./useModal";
import { shortcutList } from "../lib/menu";
import { formatShortcut } from "../lib/formatShortcut";
import { menuMnemonics, type MenuId } from "../lib/actions";
import { useLanguage, useT } from "../i18n";
import { updateInfo } from "../lib/update";
import { describeInstall } from "../lib/updateState";
export function HelpDialog({ about, onClose }: { about: boolean; onClose(): void }) {
  const dialog = useModal();
  const t = useT();
  const language = useLanguage();
  const mnemonics = menuMnemonics[language];
  const altKeys = (Object.keys(mnemonics) as MenuId[]).map(id => `Alt+${t(`menu.${id}`)[mnemonics[id]].toUpperCase()}`).join(" / ");
  const [version, setVersion] = useState("wird geladen…");
  const [license, setLicense] = useState(false);
  const [install, setInstall] = useState("");
  useEffect(() => { if (about) void getVersion().then(setVersion).catch(() => setVersion("nicht verfügbar")); }, [about]);
  // update_info is local (no network); a missing command just leaves the line without the install kind.
  useEffect(() => { if (about) void updateInfo().then(info => setInstall(describeInstall(info))).catch(() => setInstall("")); }, [about]);
  return <dialog ref={dialog} className="ssh-dialog" aria-label={about ? t("menu.help.about") : t("menu.help.shortcuts")} onCancel={e => { e.preventDefault(); onClose(); }}>
    <h2>{about ? t("menu.help.about") : t("menu.help.shortcuts")}</h2>{about ? <><p>Werkterm {version}{install && ` (${install})`}</p><p>Lizenz: GPL-3.0-or-later</p><p>Unabhängiges Projekt, keine Verbindung zu Mobatek/MobaXterm</p><ul>{["Tauri (MIT/Apache-2.0)", "russh (Apache-2.0)", "xterm.js (MIT)", "CodeMirror (MIT)", "React (MIT)", "Tabler Icons (MIT)", "keyring (MIT/Apache-2.0)", "portable-pty (MIT)"].map(component => <li key={component}>{component}</li>)}</ul><a className="license-link" href="#werkterm-license" onClick={e => { e.preventDefault(); setLicense(!license); }}>LICENSE-Datei</a>{license && <pre id="werkterm-license" className="license-text">{licenseText}</pre>}</> : <><dl>{shortcutList().map(entry => <div key={entry.action}><dt>{entry.label}</dt><dd>{entry.shortcut}</dd></div>)}</dl><p>{t("help.menuKeys.f10")} {t("help.menuKeys.alt", { keys: altKeys })} {t("help.menuKeys.nav")}</p><p>{t("help.editorKeys", { save: formatShortcut(["ctrl", "S"]), find: formatShortcut(["ctrl", "F"]), replace: formatShortcut(["ctrl", "H"]), undo: formatShortcut(["ctrl", "Z"]), redo: formatShortcut(["ctrl", "shift", "Z"]) })}</p></>}
    <div className="dialog-actions"><button autoFocus onClick={onClose}>Schließen</button></div>
  </dialog>;
}
