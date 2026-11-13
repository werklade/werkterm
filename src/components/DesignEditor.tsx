import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import { currentLocale, t, useT, type TextKey } from "../i18n";
import { applyDesign, builtInDesigns, contrastRatio, designLabel, designsChangedEvent, editorTokens, getDesign, getUserDesigns, normalizeDesign, registerUserDesign, unregisterUserDesign, uiTokens, type Design, type StoredDesign } from "../lib/designs";
import { ansiKeys } from "../lib/terminalThemes";
import "./DesignEditor.css";

export function parseDesignColor(text: string): string | undefined {
  if (/^#[0-9a-f]{3}$/i.test(text)) return `#${[...text.slice(1)].map(c => c + c).join("")}`.toLowerCase();
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(text) ? text.toLowerCase() : undefined;
}
export function editableDesign(design: Design, builtIn: boolean): Design {
  return normalizeDesign({ ...design, name: builtIn ? `${designLabel(design.name)}${t("design.copySuffix")}`.slice(0, 60) : design.name }, design);
}
/** Display name of a colour role token (keys `design.role.<token>`); unknown tokens are shown as they are. */
export function roleLabel(token: string): string {
  const key = `design.role.${token}` as TextKey;
  const text = t(key);
  return text === key ? token : text;
}
export function ColorRow({ token, value, onChange }: { token: string; value: string; onChange(value: string): void }) {
  useT();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const valid = parseDesignColor(text);
  const label = roleLabel(token);
  return <div className="design-color-row"><label>{label}<input aria-label={t("design.colorPicker", { name: label })} type="color" value={value.slice(0, 7)} onChange={e => onChange(e.target.value + (value.length === 9 ? value.slice(7) : ""))} /></label><input aria-label={t("design.colorHex", { name: label })} value={text} aria-invalid={!valid} onChange={e => { setText(e.target.value); const color = parseDesignColor(e.target.value); if (color) onChange(color); }} />{!valid && <span role="alert">{t("design.invalidHex")}</span>}</div>;
}
export function DesignEditor({ name, onChange }: { name: string; onChange(name: string): void }) {
  useT();
  const [users, setUsers] = useState<StoredDesign[]>(getUserDesigns);
  const [design, setDesign] = useState(() => getDesign(name));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const originals = useRef(new Map<string, Design>([...Object.values(builtInDesigns), ...getUserDesigns().map(s => s.design)].map(d => [d.name, structuredClone(d)])));
  const current = useRef(design); current.current = design;
  const touched = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ id: string; design: Design } | null>(null);
  const saving = useRef(Promise.resolve());
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current; pending.current = null;
    if (next) saving.current = saving.current.then(async () => { await invoke("designs_save", { id: next.id, design: next.design }); }).catch(reason => setError(String(reason)));
  };
  useEffect(() => {
    const update = () => setUsers(getUserDesigns());
    window.addEventListener(designsChangedEvent, update);
    void invoke<StoredDesign[]>("designs_list").then(items => { for (const item of items) { const existing = getUserDesigns().find(stored => stored.id === item.id); const normalized = existing?.design ?? normalizeDesign(item.design, getDesign("Werklade Dunkel")); if (!existing) registerUserDesign(item.id, normalized); if (!originals.current.has(normalized.name)) originals.current.set(normalized.name, structuredClone(normalized)); } if (!touched.current) setDesign(getDesign(name)); }).catch(reason => setError(String(reason)));
    return () => { window.removeEventListener(designsChangedEvent, update); flush(); };
  }, []);
  useEffect(() => { const next = getDesign(name); setDesign(next); if (!originals.current.has(next.name)) originals.current.set(next.name, structuredClone(next)); }, [name]);
  const select = (next: string) => { touched.current = true; flush(); setRename(null); setDesign(getDesign(next)); onChange(next); };
  /** Names a user design must not take: the persisted ids and the displayed names of the built-in designs. */
  const takenNames = () => [...Object.keys(builtInDesigns), ...Object.keys(builtInDesigns).map(designLabel), ...getUserDesigns().map(d => d.design.name)];
  const uniqueName = (base: string) => {
    const names = takenNames();
    let next = base.slice(0, 60), count = 2;
    while (names.includes(next)) { const suffix = ` (${count++})`; next = base.slice(0, 60 - suffix.length) + suffix; }
    return next;
  };
  const create = async (next: Design, activate = true) => {
    const copy = { ...next, name: uniqueName(next.name) };
    const id = await invoke<string>("designs_save", { id: null, design: copy });
    registerUserDesign(id, copy); originals.current.set(copy.name, structuredClone(copy)); if (activate) { current.current = copy; setDesign(copy); onChange(copy.name); } return { id, design: copy };
  };
  const copyInFlight = useRef<Promise<StoredDesign> | null>(null);
  const edit = (group: "ui" | "terminal" | "editor", token: string, color: string) => {
    touched.current = true;
    const next = normalizeDesign({ ...current.current, [group]: { ...current.current[group], [token]: color } }, current.current);
    current.current = next; setDesign(next); applyDesign(next);
    const stored = getUserDesigns().find(item => item.design.name === next.name);
    if (stored) { registerUserDesign(stored.id, next); pending.current = { id: stored.id, design: next }; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(flush, 400); }
    else {
      if (!copyInFlight.current) {
        const original = structuredClone(originals.current.get(next.name) ?? getDesign(next.name));
        setBusy(true);
        copyInFlight.current = create(editableDesign(next, true), false).then(item => { originals.current.set(item.design.name, { ...original, name: item.design.name }); return item; });
      }
      void copyInFlight.current.then(item => { const latest = { ...current.current, name: item.design.name }; current.current = latest; setDesign(latest); registerUserDesign(item.id, latest); onChange(latest.name); pending.current = { id: item.id, design: latest }; timer.current = setTimeout(flush, 400); }).catch(reason => setError(String(reason))).finally(() => { copyInFlight.current = null; setBusy(false); });
    }
  };
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(""); try { flush(); await saving.current; await action(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } };
  const user = users.find(item => item.design.name === design.name);
  const status = new Set(["accent", "accent-hover", "accent-hover-fill", "on-accent", "focus-ring", "danger", "warning", "success", "warning-bg", "error-bg"]);
  const groups: { id: string; title: TextKey; group: "ui" | "terminal" | "editor"; keys: readonly string[] }[] = [
    { id: "ui", title: "design.group.ui", group: "ui", keys: uiTokens.filter(k => !status.has(k) && !k.startsWith("monitor-")) }, { id: "status", title: "design.group.status", group: "ui", keys: uiTokens.filter(k => status.has(k)) }, { id: "terminal", title: "design.group.terminal", group: "terminal", keys: ["background", "foreground", "cursor", "selectionBackground", ...ansiKeys] }, { id: "editor", title: "design.group.editor", group: "editor", keys: editorTokens }, { id: "monitoring", title: "design.group.monitoring", group: "ui", keys: uiTokens.filter(k => k.startsWith("monitor-")) },
  ];
  const pairs: [TextKey, string, string][] = [["design.pair.textApp", design.ui["fg-primary"], design.ui["bg-app"]], ["design.pair.textPanel", design.ui["fg-primary"], design.ui["bg-panel"]], ["design.pair.secondaryPanel", design.ui["fg-secondary"], design.ui["bg-panel"]], ["design.pair.textAccent", design.ui["on-accent"], design.ui.accent], ["design.pair.textAccentHover", design.ui["on-accent"], design.ui["accent-hover-fill"]], ["design.pair.terminal", design.terminal.foreground, design.terminal.background], ["design.pair.editorVariable", design.editor.variable, design.terminal.background]];
  const fileFilter = [{ name: t("design.fileFilter"), extensions: ["json"] }];
  return <div className="design-editor"><label>{t("design.label")}<select value={design.name} disabled={busy} onChange={e => select(e.target.value)}>{Object.keys(builtInDesigns).map(n => <option key={n} value={n}>{designLabel(n)}</option>)}{users.map(item => <option key={item.id}>{item.design.name}</option>)}</select></label>
    <div className="design-actions"><button disabled={busy} onClick={() => void run(async () => { await create(editableDesign(design, true)); })}>{t("design.duplicate")}</button><button disabled={busy || !user} onClick={() => setRename(design.name)}>{t("design.rename")}</button><button disabled={busy || !user} onClick={() => void run(async () => { if (user && await confirm(t("design.delete.confirm", { name: design.name }), { title: t("design.delete.title"), kind: "warning" })) { await invoke("designs_delete", { id: user.id }); unregisterUserDesign(user.id); select("Werklade Dunkel"); } })}>{t("common.delete")}</button><button disabled={busy} onClick={() => void run(async () => { const path = await save({ title: t("design.export.title"), defaultPath: `${design.name.replace(/[<>:"/\\|?*]/g, "-")}.werkterm-design.json`, filters: fileFilter }); if (path) await invoke("designs_export", { id: null, design, path }); })}>{t("design.export")}</button><button disabled={busy} onClick={() => void run(async () => { const path = await open({ title: t("design.import.title"), multiple: false, filters: fileFilter }); if (typeof path === "string") await create(normalizeDesign(await invoke("designs_import", { path }), getDesign("Werklade Dunkel"))); })}>{t("design.import")}</button></div>
    {rename !== null && <form className="design-rename" onSubmit={e => { e.preventDefault(); void run(async () => { if (!user || !rename.trim()) return; const nextName = rename.trim().slice(0, 60); if (nextName !== design.name && [...takenNames(), ...users.map(s => s.design.name)].includes(nextName)) throw new Error(t("design.nameTaken")); const next = { ...design, name: nextName }; await invoke("designs_save", { id: user.id, design: next }); const original = originals.current.get(design.name); if (original) originals.current.set(nextName, { ...original, name: nextName }); registerUserDesign(user.id, next); setRename(null); setDesign(next); onChange(nextName); }); }}><input aria-label={t("design.newName")} maxLength={60} value={rename} onChange={e => setRename(e.target.value)} /><button disabled={busy || !rename.trim()}>{t("common.save")}</button><button type="button" onClick={() => setRename(null)}>{t("common.cancel")}</button></form>}
    {!user && <p>{t("design.builtInNote")}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="design-preview" aria-label={t("design.preview")}><div className="design-preview-menu">{t("design.preview.menu")}</div><div className="design-preview-tab">{t("design.preview.tab")}</div><div className="design-preview-selected">{t("design.preview.selected")}</div><pre>marc@werkterm:~$ ls{"\n"}<span>{t("design.preview.files")}</span>{"\n"}{t("design.preview.ready")}</pre></div>
    <div className="design-contrast">{pairs.map(([label, fg, bg]) => { const ratio = contrastRatio(fg, bg); return ratio < 4.5 ? <p key={label} role="status">{t("design.contrast.warning", { label: t(label), ratio: ratio.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}</p> : null; })}</div>
    <fieldset className="design-colors" disabled={busy}>{groups.map(section => <details key={section.id}><summary>{t(section.title)}</summary>{section.keys.map(token => <ColorRow key={token} token={token} value={(design[section.group] as Record<string, string>)[token]} onChange={color => edit(section.group, token, color)} />)}</details>)}</fieldset>
    <button disabled={busy} onClick={() => void run(async () => { const original = originals.current.get(design.name); if (original && user) { await invoke("designs_save", { id: user.id, design: original }); registerUserDesign(user.id, original); current.current = original; setDesign(original); applyDesign(original); } })}>{t("design.reset")}</button>
  </div>;
}
