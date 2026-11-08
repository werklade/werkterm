import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { Icon, standardIcons, type IconName } from "./Icon";
import type { StoredIconSet } from "../lib/iconSets";
const preview: IconName[] = ["terminal", "star", "tools", "globe", "folder", "file", "download", "upload", "save", "debian", "windows", "tux"];
export function IconSetEditor({ value, onChange }: { value: string; onChange(value: string): void }) {
  const [sets, setSets] = useState<StoredIconSet[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [name, setName] = useState("");
  const refresh = async () => setSets(await invoke<StoredIconSet[]>("icon_sets_list"));
  useEffect(() => { void refresh().catch(reason => setError(String(reason))); }, []);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(""); setMessages([]);
    try { await work(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const imported = sets.find(set => set.id === value);
  return <section className="icon-set-editor" aria-label="Icons" aria-busy={busy}>
    <h3>Icons</h3><label>Icon-Set<select value={value} disabled={busy} onChange={event => onChange(event.target.value)}>
      <option>Standard</option><option>Werklade</option>{sets.map(set => <option key={set.id} value={set.id}>{set.name}</option>)}
      {!imported && value !== "Standard" && value !== "Werklade" && <option value={value}>Nicht verfügbares Icon-Set</option>}
    </select></label>
    <div className="icon-set-preview" aria-label="Icon-Vorschau">{preview.map(icon => <span key={icon} title={icon}><Icon name={icon} /></span>)}</div>
    <div className="icon-set-actions"><button disabled={busy} onClick={() => void run(async () => {
      const chosen = await open({ directory: true, multiple: false, title: "Icon-Set importieren" });
      if (typeof chosen === "string") { setFolder(chosen); setName(""); }
    })}>Icon-Set importieren…</button>
    <button disabled={busy} onClick={() => void run(async () => {
      const chosen = await open({ directory: true, multiple: false, title: "Icon-Vorlage exportieren" });
      if (typeof chosen !== "string") return;
      const result = await invoke<{ written: number; skipped: string[] }>("icon_sets_export_template", { folder: chosen, icons: standardIcons });
      setMessages([`${result.written} Dateien geschrieben, ${result.skipped.length} übersprungen.`, ...result.skipped.map(file => `Übersprungen: ${file}`)]);
    })}>Vorlage exportieren…</button>
    <button disabled={busy || !imported} onClick={() => void run(async () => {
      if (!imported || !await confirm(`Icon-Set „${imported.name}“ löschen? Danach wird Standard verwendet.`, { title: "Icon-Set löschen", kind: "warning" })) return;
      await invoke("icon_sets_delete", { id: imported.id }); onChange("Standard"); await refresh();
    })}>Löschen</button></div>
    {folder !== null && <form onSubmit={event => { event.preventDefault(); void run(async () => {
      const result = await invoke<{ id: string; warnings: string[] }>("icon_sets_import", { folder, name: name.trim(), known: Object.keys(standardIcons) });
      await refresh(); onChange(result.id); setFolder(null); setMessages(["Icon-Set importiert.", ...result.warnings]);
    }); }}><label>Name des Icon-Sets<input autoFocus maxLength={60} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <button disabled={busy || !name.trim()}>Importieren</button><button type="button" disabled={busy} onClick={() => setFolder(null)}>Abbrechen</button></form>}
    <p>Dateinamen müssen den Icon-Namen entsprechen (z. B. folder.svg). Fehlende Icons verwenden Standard. Die Klasse class="wl-fill" markiert Flächen, die im Set Werklade die Akzenttönung erhalten. Der Export enthält alle Namen und überschreibt keine Dateien.</p>
    {error && <p role="alert">{error}</p>}{messages.length > 0 && <div role="status">{messages.map((message, index) => <p key={index}>{message}</p>)}</div>}
  </section>;
}
