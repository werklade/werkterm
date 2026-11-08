import { useModal } from "./useModal";
import type { DirEntry } from "../lib/fs";
export type ContextAction = "edit" | "download" | "chmod" | "delete" | "remember" | "compare";
export function BrowserContextMenu({ entry, x, y, onAnswer, markedName, permissionsDisabled, permissionsTitle }: { permissionsDisabled?: boolean; permissionsTitle?: string; markedName?: string; entry: DirEntry; x: number; y: number; onAnswer: (action: ContextAction | null) => void }) {
  const dialog = useModal();
  const file = entry.kind === "file" || (entry.kind === "symlink" && !entry.targetIsDir);
  const items: { action: ContextAction; label: string; disabled?: boolean; title?: string }[] = [
    ...(file ? [{ action: "edit" as const, label: "Öffnen im Editor" }] : []),
    ...(entry.kind === "file" || entry.kind === "dir" ? [{ action: "remember" as const, label: "Zum Vergleich merken" }, ...(markedName ? [{ action: "compare" as const, label: `Mit ${markedName} vergleichen` }] : [])] : []),
    { action: "download", label: "Herunterladen", disabled: !file },
    { action: "chmod", label: "Berechtigungen…", disabled: permissionsDisabled || entry.kind === "symlink", title: permissionsDisabled ? permissionsTitle : undefined },
    { action: "delete", label: "Löschen" },
  ];
  return <dialog ref={dialog} className="browser-context-menu" style={{ left: Math.max(8, Math.min(x, window.innerWidth - 280)), top: Math.max(8, Math.min(y, window.innerHeight - 200)) }} aria-label={`Aktionen für ${entry.name}`} onCancel={event => { event.preventDefault(); onAnswer(null); }} onClick={event => { if (event.target === event.currentTarget) onAnswer(null); }}>
    <div role="menu" onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>{items.map((item, index) => <button key={item.action} autoFocus={index === 0} role="menuitem" title={item.title} disabled={item.disabled} onClick={() => onAnswer(item.action)}>{item.label}</button>)}</div>
  </dialog>;
}
