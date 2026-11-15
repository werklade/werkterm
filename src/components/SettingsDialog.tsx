import { IconSetEditor } from "./IconSetEditor";
import { errorText } from "../lib/backendError";
import { DesignEditor } from "./DesignEditor";
import { tuxTestEvent } from "./TuxOverlay";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { defaultLogFolder } from "../lib/sessionLog";
import { useModal } from "./useModal";
import { describeRemembered, hasRemembered, resetRemembered } from "../lib/paste";
import { defaultSettings, normalizeSettings, selectedTheme, type Settings } from "../lib/settings";
import { ansiKeys, importedThemeId, terminalThemes, themeLabel, type TerminalTheme } from "../lib/terminalThemes";
import { dataDirStatus, type DataDirStatus } from "../lib/dataDir";
import { DataDirSection } from "./DataDirForm";
import { updateStartNote } from "../lib/updateState";
import { nextTabIndex } from "../lib/tabKeys";
import { useT, type LanguageSetting, type TextKey } from "../i18n";
type SettingsTab = "general" | "terminal" | "editor" | "log" | "design" | "updates" | "dataDir";
const tabs: { id: SettingsTab; label: TextKey }[] = [
  { id: "general", label: "settings.tab.general" }, { id: "terminal", label: "settings.tab.terminal" }, { id: "editor", label: "settings.tab.editor" },
  { id: "log", label: "settings.tab.log" }, { id: "design", label: "settings.tab.design" }, { id: "updates", label: "settings.tab.updates" }, { id: "dataDir", label: "settings.tab.dataDir" },
];
function NumberSetting({ label, value, min, max, step, onValue }: { label: string; value: number; min: number; max: number; step: number; onValue(value: number): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <label>{label}<input type="number" min={min} max={max} step={step} value={draft} onChange={e => {
    const text = e.target.value; setDraft(text);
    const next = Number(text);
    if (text !== "" && Number.isFinite(next) && next >= min && next <= max) onValue(next);
  }} onBlur={() => {
    const parsed = Number(draft);
    const next = draft !== "" && Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : value;
    setDraft(String(next)); onValue(next);
  }} /></label>;
}
export function SettingsDialog({ settings, onChange, onClose, onClearRecents, tabPasteCount = 0, onResetTabPaste, onChangeDataDir, onDefaultDataDir }: { settings: Settings; onChange(settings: Settings): void; onClose(): void; onClearRecents(): void; tabPasteCount?: number; onResetTabPaste?(): void; onChangeDataDir?(status: DataDirStatus): void; onDefaultDataDir?(status: DataDirStatus): void }) {
  const dialog = useModal();
  const t = useT();
  const [tab, setTab] = useState<SettingsTab>("general");
  const [error, setError] = useState("");
  const [dataDir, setDataDir] = useState<DataDirStatus | null>(null);
  const [dataDirError, setDataDirError] = useState("");
  useEffect(() => { void dataDirStatus().then(setDataDir).catch(reason => setDataDirError(errorText(reason))); }, []);
  const [busy, setBusy] = useState(false);
  const current = useRef(settings); current.current = settings;
  const change = (patch: Partial<Settings>) => onChange(normalizeSettings({ ...current.current, ...patch }));
  const number = (label: string, key: "fontSize" | "lineHeight" | "scrollback" | "editorFontSize" | "tuxIdleMinutes" | "tuxCount", min: number, max: number, step = 1) => <NumberSetting key={key} label={label} value={settings[key]} min={min} max={max} step={step} onValue={value => change({ [key]: value })} />;
  const check = (label: string, key: "tuxEnabled" | "copyOnSelect" | "cursorBlink" | "editorWrap" | "confirmCloseSsh" | "logAllSessions" | "logStripAnsi") => <label className="settings-check"><input type="checkbox" checked={settings[key]} onChange={e => change({ [key]: e.target.checked })} />{label}</label>;
  const importColors = async () => {
    setBusy(true); setError("");
    try {
      let imported: TerminalTheme;
      try { imported = await invoke<TerminalTheme>("import_mobaxterm_colors", { path: null }); }
      catch {
        const path = await open({ title: t("settings.importColors.title"), filters: [{ name: "MobaXterm.ini", extensions: ["ini"] }], multiple: false, directory: false });
        if (typeof path !== "string") return;
        imported = await invoke<TerminalTheme>("import_mobaxterm_colors", { path });
      }
      change({ importedTheme: imported, theme: importedThemeId });
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  useEffect(() => { if (!current.current.logFolder) void defaultLogFolder().then(logFolder => { if (!current.current.logFolder) change({ logFolder }); }).catch(reason => setError(errorText(reason))); }, []);
  const theme = selectedTheme(settings);
  return <dialog ref={dialog} className="ssh-dialog settings-dialog" aria-label={t("menu.settings")} onCancel={e => { e.preventDefault(); onClose(); }}>
    <h2>{t("menu.settings")}</h2><div className="settings-body"><div role="tablist" aria-orientation="vertical" aria-label={t("settings.tabs.label")}>{tabs.map((entry, index) => <button id={`settings-tab-${entry.id}`} role="tab" aria-selected={tab === entry.id} aria-controls="settings-panel" tabIndex={tab === entry.id ? 0 : -1} key={entry.id} onKeyDown={e => { const target = nextTabIndex(e.key, index, tabs.length); if (target !== null) { e.preventDefault(); const next = tabs[target].id; setTab(next); document.getElementById(`settings-tab-${next}`)?.focus(); } }} onClick={() => setTab(entry.id)}>{t(entry.label)}</button>)}</div>
    <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="settings-fields">{tab === "general" ? <>
      <label>{t("settings.language")}<select value={settings.language} onChange={e => change({ language: e.target.value as LanguageSetting })}><option value="system">{t("settings.language.system")}</option><option value="de">{t("settings.language.de")}</option><option value="en">{t("settings.language.en")}</option></select></label>
      <div className="settings-action-row"><button type="button" className="settings-secondary" onClick={onClearRecents}>{t("settings.clearRecents")}</button></div>
    </> : tab === "terminal" ? <>
      <h3>{t("settings.tux.heading")}</h3>{check(t("settings.tux.enable"), "tuxEnabled")}{number(t("settings.tux.idle"), "tuxIdleMinutes", 1, 120)}{number(t("settings.tux.count"), "tuxCount", 1, 8)}<button onClick={() => { onClose(); setTimeout(() => window.dispatchEvent(new Event(tuxTestEvent)), 100); }}>{t("settings.tux.test")}</button>
      <label>{t("settings.pasteConfirm")}<select value={settings.pasteConfirm} onChange={e => change({ pasteConfirm: e.target.value as Settings["pasteConfirm"] })}><option value="multiline">{t("settings.pasteConfirm.multiline")}</option><option value="always">{t("settings.pasteConfirm.always")}</option><option value="never">{t("settings.pasteConfirm.never")}</option></select></label>
      <div className="settings-remembered"><span role="status">{describeRemembered(settings.pasteRemember, tabPasteCount)}</span><button type="button" disabled={!hasRemembered(settings.pasteRemember, tabPasteCount)} onClick={() => { change({ pasteRemember: resetRemembered() }); onResetTabPaste?.(); }}>{t("settings.pasteReset")}</button></div>
      <label>{t("settings.fontFamily")}<input list="mono-fonts" value={settings.fontFamily} onChange={e => change({ fontFamily: e.target.value })} /></label><datalist id="mono-fonts">{["Cascadia Mono", "DejaVu Sans Mono", "Consolas", "Liberation Mono", "Ubuntu Mono", "monospace"].map(font => <option key={font} value={font} />)}</datalist>
      {number(t("settings.fontSize"), "fontSize", 8, 32)}{number(t("settings.lineHeight"), "lineHeight", 1, 2, .1)}
      <label>{t("settings.cursorStyle")}<select value={settings.cursorStyle} onChange={e => change({ cursorStyle: e.target.value as Settings["cursorStyle"] })}><option value="block">{t("settings.cursorStyle.block")}</option><option value="bar">{t("settings.cursorStyle.bar")}</option><option value="underline">{t("settings.cursorStyle.underline")}</option></select></label>
      {check(t("settings.confirmCloseSsh"), "confirmCloseSsh")}
      {check(t("settings.copyOnSelect"), "copyOnSelect")}<label>{t("settings.rightClick")}<select value={settings.rightClick} onChange={e => change({ rightClick: e.target.value as "menu" | "paste" })}><option value="menu">{t("settings.rightClick.menu")}</option><option value="paste">{t("settings.rightClick.paste")}</option></select></label>
      {check(t("settings.cursorBlink"), "cursorBlink")}{number(t("settings.scrollback"), "scrollback", 1000, 100000)}
      <label>{t("settings.colorScheme")}<select value={settings.theme} onChange={e => change({ theme: e.target.value })}><option value="design">{t("settings.colorScheme.design")}</option>{[...Object.keys(terminalThemes), ...(settings.importedTheme ? [importedThemeId] : [])].map(name => <option key={name} value={name}>{themeLabel(name)}</option>)}</select></label>
      <div className="theme-preview" style={{ background: theme.background, color: theme.foreground }}><p>{t("settings.preview")}</p><div>{ansiKeys.map(key => <span key={key} title={`${key}: ${theme[key]}`} style={{ background: theme[key] }} />)}</div></div>
      <button disabled={busy} onClick={() => void importColors()}>{t("settings.importColors")}</button>
    </> : tab === "log" ? <><label>{t("settings.log.folder")}<input value={settings.logFolder} onChange={e => change({ logFolder: e.target.value })} /></label><button onClick={() => { void open({ directory: true, multiple: false, title: t("settings.log.chooseTitle") }).then(path => { if (typeof path === "string") change({ logFolder: path }); }).catch(reason => setError(errorText(reason))); }}>{t("settings.log.choose")}</button>{check(t("settings.log.all"), "logAllSessions")}{check(t("settings.log.strip"), "logStripAnsi")}<p>{t("settings.log.note")}</p></> : tab === "updates" ? <><label className="settings-check"><input type="checkbox" aria-describedby="update-start-note" checked={settings.updateCheckOnStart} onChange={e => change({ updateCheckOnStart: e.target.checked })} />{t("settings.updates.onStart")}</label><p id="update-start-note">{updateStartNote()}</p></> : tab === "dataDir" ? <DataDirSection status={dataDir} error={dataDirError} onChange={() => { if (dataDir) onChangeDataDir?.(dataDir); }} onDefault={() => { if (dataDir) onDefaultDataDir?.(dataDir); }} /> : tab === "design" ? null : <>{number(t("settings.fontSize"), "editorFontSize", 8, 32)}{check(t("settings.editor.wrap"), "editorWrap")}<label>{t("settings.editor.tabSize")}<select value={settings.editorTabSize} onChange={e => change({ editorTabSize: Number(e.target.value) as 2 | 4 | 8 })}>{[2, 4, 8].map(n => <option key={n}>{n}</option>)}</select></label></>}<div hidden={tab !== "design"}><DesignEditor name={settings.design} onChange={design => change({ design })} /><IconSetEditor value={settings.iconSet} onChange={iconSet => change({ iconSet })} /></div></div></div>
    <div className="settings-footer">{error && <p role="alert">{error}</p>}<p>{t("settings.autoApply")}</p><div className="dialog-actions"><button hidden={tab === "general" || tab === "design" || tab === "dataDir" || tab === "updates"} onClick={() => change(tab === "terminal" ? { tuxEnabled: true, tuxIdleMinutes: 10, tuxCount: 4, copyOnSelect: true, rightClick: "menu", pasteConfirm: defaultSettings.pasteConfirm, fontFamily: defaultSettings.fontFamily, fontSize: 14, lineHeight: 1, cursorStyle: "block", cursorBlink: true, scrollback: 1000, theme: defaultSettings.theme } : tab === "log" ? { logFolder: "", logAllSessions: false, logStripAnsi: true } : { editorFontSize: 14, editorWrap: false, editorTabSize: 4 })}>{t("settings.reset")}</button><button autoFocus onClick={onClose}>{t("common.close")}</button></div></div>
  </dialog>;
}
