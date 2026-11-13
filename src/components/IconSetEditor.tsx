import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { Icon, standardIcons, type IconName } from "./Icon";
import { iconSetLabel, type StoredIconSet } from "../lib/iconSets";
import { tp, useT } from "../i18n";
const preview: IconName[] = ["terminal", "star", "tools", "globe", "folder", "file", "download", "upload", "save", "debian", "windows", "tux"];
export function IconSetEditor({ value, onChange }: { value: string; onChange(value: string): void }) {
  const t = useT();
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
  return <section className="icon-set-editor" aria-label={t("iconSet.heading")} aria-busy={busy}>
    <h3>{t("iconSet.heading")}</h3><label>{t("iconSet.label")}<select value={value} disabled={busy} onChange={event => onChange(event.target.value)}>
      <option value="Standard">{iconSetLabel("Standard")}</option><option value="Werklade">Werklade</option>{sets.map(set => <option key={set.id} value={set.id}>{set.name}</option>)}
      {!imported && value !== "Standard" && value !== "Werklade" && <option value={value}>{t("iconSet.unavailable")}</option>}
    </select></label>
    <div className="icon-set-preview" aria-label={t("iconSet.preview")}>{preview.map(icon => <span key={icon} title={icon}><Icon name={icon} /></span>)}</div>
    <div className="icon-set-actions"><button disabled={busy} onClick={() => void run(async () => {
      const chosen = await open({ directory: true, multiple: false, title: t("iconSet.import.title") });
      if (typeof chosen === "string") { setFolder(chosen); setName(""); }
    })}>{t("iconSet.import")}</button>
    <button disabled={busy} onClick={() => void run(async () => {
      const chosen = await open({ directory: true, multiple: false, title: t("iconSet.exportTemplate.title") });
      if (typeof chosen !== "string") return;
      const result = await invoke<{ written: number; skipped: string[] }>("icon_sets_export_template", { folder: chosen, icons: standardIcons });
      setMessages([tp("iconSet.exported", result.written, { skipped: result.skipped.length }), ...result.skipped.map(file => t("iconSet.skipped", { file }))]);
    })}>{t("iconSet.exportTemplate")}</button>
    <button disabled={busy || !imported} onClick={() => void run(async () => {
      if (!imported || !await confirm(t("iconSet.delete.confirm", { name: imported.name }), { title: t("iconSet.delete.title"), kind: "warning" })) return;
      await invoke("icon_sets_delete", { id: imported.id }); onChange("Standard"); await refresh();
    })}>{t("common.delete")}</button></div>
    {folder !== null && <form onSubmit={event => { event.preventDefault(); void run(async () => {
      const result = await invoke<{ id: string; warnings: string[] }>("icon_sets_import", { folder, name: name.trim(), known: Object.keys(standardIcons) });
      await refresh(); onChange(result.id); setFolder(null); setMessages([t("iconSet.imported"), ...result.warnings]);
    }); }}><label>{t("iconSet.name")}<input autoFocus maxLength={60} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <button disabled={busy || !name.trim()}>{t("iconSet.importSubmit")}</button><button type="button" disabled={busy} onClick={() => setFolder(null)}>{t("common.cancel")}</button></form>}
    <p>{t("iconSet.help")}</p>
    {error && <p role="alert">{error}</p>}{messages.length > 0 && <div role="status">{messages.map((message, index) => <p key={index}>{message}</p>)}</div>}
  </section>;
}
