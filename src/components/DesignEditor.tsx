import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import { applyDesign, builtInDesigns, contrastRatio, designsChangedEvent, editorTokens, getDesign, getUserDesigns, normalizeDesign, registerUserDesign, unregisterUserDesign, uiTokens, type Design, type StoredDesign } from "../lib/designs";
import { ansiKeys } from "../lib/terminalThemes";
import "./DesignEditor.css";

export function parseDesignColor(text: string): string | undefined {
  if (/^#[0-9a-f]{3}$/i.test(text)) return `#${[...text.slice(1)].map(c => c + c).join("")}`.toLowerCase();
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(text) ? text.toLowerCase() : undefined;
}
export function editableDesign(design: Design, builtIn: boolean): Design {
  return normalizeDesign({ ...design, name: builtIn ? `${design.name} (Kopie)`.slice(0, 60) : design.name }, design);
}
const labels: Record<string, string> = {
  "bg-content": "Inhalt", "bg-app": "App-Hintergrund", "bg-panel": "Seitenleiste", "bg-panel-alt": "Zweiter Bereich", "bg-toolbar": "Werkzeugleiste", "bg-menubar": "Menüleiste", "bg-input": "Eingabefelder", "bg-hover": "Zeiger darüber", "bg-active": "Aktiver Bereich", "bg-tab": "Inaktiver Tab", "bg-tab-active": "Aktiver Tab", "fg-primary": "Text", "fg-secondary": "Sekundärer Text", "fg-muted": "Gedämpfter Text", "fg-inverse": "Inverser Text", "accent": "Akzent", "accent-hover": "Akzent beim Zeigen", "accent-hover-fill": "Akzentfläche beim Zeigen", "on-accent": "Text auf Akzent", "border": "Rahmen", "border-strong": "Starker Rahmen", "focus-ring": "Tastaturfokus", "danger": "Fehler", "warning": "Warnung", "success": "Erfolg", "selection": "Auswahl", "monitor-ok": "Normal", "monitor-warn": "Warnung", "monitor-critical": "Kritisch", "backdrop": "Dialog-Abdunklung", "shadow": "Schatten", "warning-bg": "Warnungshintergrund", "error-bg": "Fehlerhintergrund", "indent-guide": "Einrückungslinie", "diff-added": "Hinzugefügt", "diff-deleted": "Entfernt", "diff-added-text": "Hinzugefügter Text", "diff-deleted-text": "Entfernter Text", background: "Hintergrund", foreground: "Text", cursor: "Cursor", selectionBackground: "Auswahl", keyword: "Schlüsselwort", string: "Zeichenfolge", comment: "Kommentar", number: "Zahl", function: "Funktion", type: "Typ", variable: "Variable", property: "Eigenschaft", operator: "Operator", tag: "Tag", attribute: "Attribut", meta: "Metadaten", invalid: "Ungültiger Code", "gutter-fg": "Zeilennummern", "active-line": "Aktive Zeile", black: "Schwarz", red: "Rot", green: "Grün", yellow: "Gelb", blue: "Blau", magenta: "Magenta", cyan: "Cyan", white: "Weiß", brightBlack: "Helles Schwarz", brightRed: "Helles Rot", brightGreen: "Helles Grün", brightYellow: "Helles Gelb", brightBlue: "Helles Blau", brightMagenta: "Helles Magenta", brightCyan: "Helles Cyan", brightWhite: "Helles Weiß",
};
export function ColorRow({ token, value, onChange }: { token: string; value: string; onChange(value: string): void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const valid = parseDesignColor(text);
  return <div className="design-color-row"><label>{labels[token] ?? token}<input aria-label={`${labels[token] ?? token} Farbwähler`} type="color" value={value.slice(0, 7)} onChange={e => onChange(e.target.value + (value.length === 9 ? value.slice(7) : ""))} /></label><input aria-label={`${labels[token] ?? token} Hex`} value={text} aria-invalid={!valid} onChange={e => { setText(e.target.value); const color = parseDesignColor(e.target.value); if (color) onChange(color); }} />{!valid && <span role="alert">Ungültige Hex-Farbe</span>}</div>;
}
export function DesignEditor({ name, onChange }: { name: string; onChange(name: string): void }) {
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
  const uniqueName = (base: string) => {
    const names = [...Object.keys(builtInDesigns), ...getUserDesigns().map(d => d.design.name)];
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
  const groups: { title: string; group: "ui" | "terminal" | "editor"; keys: readonly string[] }[] = [
    { title: "Oberfläche", group: "ui", keys: uiTokens.filter(k => !status.has(k) && !k.startsWith("monitor-")) }, { title: "Akzent und Status", group: "ui", keys: uiTokens.filter(k => status.has(k)) }, { title: "Terminal", group: "terminal", keys: ["background", "foreground", "cursor", "selectionBackground", ...ansiKeys] }, { title: "Editor", group: "editor", keys: editorTokens }, { title: "Monitoring", group: "ui", keys: uiTokens.filter(k => k.startsWith("monitor-")) },
  ];
  const pairs = [ ["Text / App", design.ui["fg-primary"], design.ui["bg-app"]], ["Text / Seitenleiste", design.ui["fg-primary"], design.ui["bg-panel"]], ["Sekundärtext / Seitenleiste", design.ui["fg-secondary"], design.ui["bg-panel"]], ["Text / Akzent", design.ui["on-accent"], design.ui.accent], ["Text / Akzent beim Zeigen", design.ui["on-accent"], design.ui["accent-hover-fill"]], ["Terminaltext / Hintergrund", design.terminal.foreground, design.terminal.background], ["Editorvariable / Hintergrund", design.editor.variable, design.terminal.background] ];
  return <div className="design-editor"><label>Design<select value={design.name} disabled={busy} onChange={e => select(e.target.value)}>{Object.keys(builtInDesigns).map(n => <option key={n}>{n}</option>)}{users.map(item => <option key={item.id}>{item.design.name}</option>)}</select></label>
    <div className="design-actions"><button disabled={busy} onClick={() => void run(async () => { await create(editableDesign(design, true)); })}>Duplizieren</button><button disabled={busy || !user} onClick={() => setRename(design.name)}>Umbenennen</button><button disabled={busy || !user} onClick={() => void run(async () => { if (user && await confirm(`Design „${design.name}“ löschen?`, { title: "Design löschen", kind: "warning" })) { await invoke("designs_delete", { id: user.id }); unregisterUserDesign(user.id); select("Werklade Dunkel"); } })}>Löschen</button><button disabled={busy} onClick={() => void run(async () => { const path = await save({ title: "Design exportieren", defaultPath: `${design.name.replace(/[<>:"/\\|?*]/g, "-")}.werkterm-design.json`, filters: [{ name: "Werkterm-Design", extensions: ["json"] }] }); if (path) await invoke("designs_export", { id: null, design, path }); })}>Exportieren…</button><button disabled={busy} onClick={() => void run(async () => { const path = await open({ title: "Design importieren", multiple: false, filters: [{ name: "Werkterm-Design", extensions: ["json"] }] }); if (typeof path === "string") await create(normalizeDesign(await invoke("designs_import", { path }), getDesign("Werklade Dunkel"))); })}>Importieren…</button></div>
    {rename !== null && <form className="design-rename" onSubmit={e => { e.preventDefault(); void run(async () => { if (!user || !rename.trim()) return; const nextName = rename.trim().slice(0, 60); if (nextName !== design.name && [...Object.keys(builtInDesigns), ...users.map(s => s.design.name)].includes(nextName)) throw new Error("Dieser Designname ist bereits vergeben."); const next = { ...design, name: nextName }; await invoke("designs_save", { id: user.id, design: next }); const original = originals.current.get(design.name); if (original) originals.current.set(nextName, { ...original, name: nextName }); registerUserDesign(user.id, next); setRename(null); setDesign(next); onChange(nextName); }); }}><input aria-label="Neuer Designname" maxLength={60} value={rename} onChange={e => setRename(e.target.value)} /><button disabled={busy || !rename.trim()}>Speichern</button><button type="button" onClick={() => setRename(null)}>Abbrechen</button></form>}
    {!user && <p>Integriertes Design: Farbänderungen erstellen automatisch eine eigene Kopie.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="design-preview" aria-label="Designvorschau"><div className="design-preview-menu">Datei · Ansicht · Werkzeuge</div><div className="design-preview-tab">Sitzung</div><div className="design-preview-selected">Ausgewählte Datei</div><pre>marc@werkterm:~$ ls{"\n"}<span>Dokumente  Projekte</span>{"\n"}Bereit.</pre></div>
    <div className="design-contrast">{pairs.map(([label, fg, bg]) => { const ratio = contrastRatio(fg, bg); return ratio < 4.5 ? <p key={label} role="status">⚠ {label}: Kontrast {ratio.toFixed(2)}:1 (empfohlen 4,5:1)</p> : null; })}</div>
    <fieldset className="design-colors" disabled={busy}>{groups.map(section => <details key={section.title}><summary>{section.title}</summary>{section.keys.map(token => <ColorRow key={token} token={token} value={(design[section.group] as Record<string, string>)[token]} onChange={color => edit(section.group, token, color)} />)}</details>)}</fieldset>
    <button disabled={busy} onClick={() => void run(async () => { const original = originals.current.get(design.name); if (original && user) { await invoke("designs_save", { id: user.id, design: original }); registerUserDesign(user.id, original); current.current = original; setDesign(original); applyDesign(original); } })}>Zurücksetzen</button>
  </div>;
}
