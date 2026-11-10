import { IconSetEditor } from "./IconSetEditor";
import { DesignEditor } from "./DesignEditor";
import { tuxTestEvent } from "./TuxOverlay";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { defaultLogFolder } from "../lib/sessionLog";
import { useModal } from "./useModal";
import { describeRemembered, hasRemembered, resetRemembered } from "../lib/paste";
import { defaultSettings, normalizeSettings, selectedTheme, type Settings } from "../lib/settings";
import { ansiKeys, terminalThemes, type TerminalTheme } from "../lib/terminalThemes";
import { dataDirStatus, type DataDirStatus } from "../lib/dataDir";
import { DataDirSection } from "./DataDirForm";
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
  const [tab, setTab] = useState("Terminal");
  const [error, setError] = useState("");
  const [dataDir, setDataDir] = useState<DataDirStatus | null>(null);
  const [dataDirError, setDataDirError] = useState("");
  useEffect(() => { void dataDirStatus().then(setDataDir).catch(reason => setDataDirError(String(reason))); }, []);
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
        const path = await open({ title: "MobaXterm-Farben importieren", filters: [{ name: "MobaXterm.ini", extensions: ["ini"] }], multiple: false, directory: false });
        if (typeof path !== "string") return;
        imported = await invoke<TerminalTheme>("import_mobaxterm_colors", { path });
      }
      change({ importedTheme: imported, theme: "MobaXterm (importiert)" });
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  useEffect(() => { if (!current.current.logFolder) void defaultLogFolder().then(logFolder => { if (!current.current.logFolder) change({ logFolder }); }).catch(reason => setError(String(reason))); }, []);
  const theme = selectedTheme(settings);
  const tabNames = ["Terminal", "Editor", "Protokoll", "Design", "Datenordner"];
  return <dialog ref={dialog} className="ssh-dialog settings-dialog" aria-label="Einstellungen" onCancel={e => { e.preventDefault(); onClose(); }}>
    <h2>Einstellungen</h2><div role="tablist" aria-label="Einstellungsbereiche">{tabNames.map(name => <button id={`settings-tab-${name}`} role="tab" aria-selected={tab === name} aria-controls="settings-panel" tabIndex={tab === name ? 0 : -1} key={name} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const next = tabNames[(tabNames.indexOf(name) + (e.key === "ArrowRight" ? 1 : tabNames.length - 1)) % tabNames.length]; setTab(next); document.getElementById(`settings-tab-${next}`)?.focus(); } }} onClick={() => setTab(name)}>{name}</button>)}</div>
    <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="settings-fields">{tab === "Terminal" ? <>
      <h3>Tux-Wanderer</h3>{check("Tux-Wanderer aktivieren", "tuxEnabled")}{number("Inaktivität (Minuten)", "tuxIdleMinutes", 1, 120)}{number("Anzahl Tuxe", "tuxCount", 1, 8)}<button onClick={() => { onClose(); setTimeout(() => window.dispatchEvent(new Event(tuxTestEvent)), 100); }}>Jetzt testen</button>
      <label>Einfügen bestätigen<select value={settings.pasteConfirm} onChange={e => change({ pasteConfirm: e.target.value as Settings["pasteConfirm"] })}><option value="multiline">Bei mehreren Zeilen</option><option value="always">Immer</option><option value="never">Nie</option></select></label>
      <div className="settings-remembered"><span role="status">{describeRemembered(settings.pasteRemember, tabPasteCount)}</span><button type="button" disabled={!hasRemembered(settings.pasteRemember, tabPasteCount)} onClick={() => { change({ pasteRemember: resetRemembered() }); onResetTabPaste?.(); }}>Gemerkte Auswahl zurücksetzen</button></div>
      <label>Schriftart<input list="mono-fonts" value={settings.fontFamily} onChange={e => change({ fontFamily: e.target.value })} /></label><datalist id="mono-fonts">{["Cascadia Mono", "DejaVu Sans Mono", "Consolas", "Liberation Mono", "Ubuntu Mono", "monospace"].map(font => <option key={font} value={font} />)}</datalist>
      {number("Schriftgröße", "fontSize", 8, 32)}{number("Zeilenhöhe", "lineHeight", 1, 2, .1)}
      <label>Cursorform<select value={settings.cursorStyle} onChange={e => change({ cursorStyle: e.target.value as Settings["cursorStyle"] })}><option value="block">Block</option><option value="bar">Strich</option><option value="underline">Unterstrich</option></select></label>
      {check("Vor dem Trennen aktiver SSH-Verbindungen fragen", "confirmCloseSsh")}
      {check("Markierten Text automatisch kopieren", "copyOnSelect")}<label>Rechtsklick<select value={settings.rightClick} onChange={e => change({ rightClick: e.target.value as "menu" | "paste" })}><option value="menu">Kontextmenü</option><option value="paste">Direkt einfügen (wie PuTTY)</option></select></label>
      {check("Cursor blinkt", "cursorBlink")}{number("Scrollback", "scrollback", 1000, 100000)}
      <label>Farbschema<select value={settings.theme} onChange={e => change({ theme: e.target.value })}><option value="design">Aus Design</option>{[...Object.keys(terminalThemes), ...(settings.importedTheme ? ["MobaXterm (importiert)"] : [])].map(name => <option key={name}>{name}</option>)}</select></label>
      <div className="theme-preview" style={{ background: theme.background, color: theme.foreground }}><p>Werkterm · Textvorschau 0123456789</p><div>{ansiKeys.map(key => <span key={key} title={`${key}: ${theme[key]}`} style={{ background: theme[key] }} />)}</div></div>
      <button disabled={busy} onClick={() => void importColors()}>Farben aus MobaXterm importieren…</button>
    </> : tab === "Protokoll" ? <><label>Protokollordner<input value={settings.logFolder} onChange={e => change({ logFolder: e.target.value })} /></label><button onClick={() => { void open({ directory: true, multiple: false, title: "Protokollordner wählen" }).then(path => { if (typeof path === "string") change({ logFolder: path }); }).catch(reason => setError(String(reason))); }}>Ordner wählen…</button>{check("Alle Sitzungen protokollieren", "logAllSessions")}{check("Farb- und Steuercodes entfernen", "logStripAnsi")}<p>Vom Server angezeigte Eingaben (Echo) erscheinen im Protokoll. Verdeckte Passworteingaben nicht.</p></> : tab === "Datenordner" ? <DataDirSection status={dataDir} error={dataDirError} onChange={() => { if (dataDir) onChangeDataDir?.(dataDir); }} onDefault={() => { if (dataDir) onDefaultDataDir?.(dataDir); }} /> : tab === "Design" ? null : <>{number("Schriftgröße", "editorFontSize", 8, 32)}{check("Zeilenumbruch standardmäßig an", "editorWrap")}<label>Tabbreite<select value={settings.editorTabSize} onChange={e => change({ editorTabSize: Number(e.target.value) as 2 | 4 | 8 })}>{[2, 4, 8].map(n => <option key={n}>{n}</option>)}</select></label></>}<div hidden={tab !== "Design"}><DesignEditor name={settings.design} onChange={design => change({ design })} /><IconSetEditor value={settings.iconSet} onChange={iconSet => change({ iconSet })} /></div></div>
    <button type="button" onClick={onClearRecents}>Zuletzt verwendet leeren</button>
    {error && <p role="alert">{error}</p>}<p>Änderungen gelten sofort.</p><div className="dialog-actions"><button hidden={tab === "Design" || tab === "Datenordner"} onClick={() => change(tab === "Terminal" ? { tuxEnabled: true, tuxIdleMinutes: 10, tuxCount: 4, copyOnSelect: true, rightClick: "menu", pasteConfirm: defaultSettings.pasteConfirm, fontFamily: defaultSettings.fontFamily, fontSize: 14, lineHeight: 1, cursorStyle: "block", cursorBlink: true, scrollback: 1000, theme: defaultSettings.theme } : tab === "Protokoll" ? { logFolder: "", logAllSessions: false, logStripAnsi: true } : { editorFontSize: 14, editorWrap: false, editorTabSize: 4 })}>Zurücksetzen</button><button autoFocus onClick={onClose}>Schließen</button></div>
  </dialog>;
}
