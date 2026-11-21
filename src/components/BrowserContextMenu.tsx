import { useModal } from "./useModal";
import type { DirEntry } from "../lib/fs";
import { useT } from "../i18n";
export type ContextAction = "edit" | "download" | "chmod" | "delete" | "remember" | "compare";
export function BrowserContextMenu({ entry, x, y, onAnswer, markedName, permissionsDisabled, permissionsTitle }: { permissionsDisabled?: boolean; permissionsTitle?: string; markedName?: string; entry: DirEntry; x: number; y: number; onAnswer: (action: ContextAction | null) => void }) {
  const t = useT();
  const file = entry.kind === "file" || (entry.kind === "symlink" && !entry.targetIsDir);
  const items: { action: ContextAction; label: string; disabled?: boolean; title?: string }[] = [
    ...(file ? [{ action: "edit" as const, label: t("browser.action.edit") }] : []),
    ...(entry.kind === "file" || entry.kind === "dir" ? [{ action: "remember" as const, label: t("browser.ctx.remember") }, ...(markedName ? [{ action: "compare" as const, label: t("browser.ctx.compare", { name: markedName }) }] : [])] : []),
    // Folders download recursively; links to folders are followed for the selected folder only.
    { action: "download", label: t("browser.action.download"), disabled: entry.kind !== "file" && entry.kind !== "dir" && entry.kind !== "symlink" },
    { action: "chmod", label: t("permissions.menu"), disabled: permissionsDisabled || entry.kind === "symlink", title: permissionsDisabled ? permissionsTitle : undefined },
    { action: "delete", label: t("common.delete") },
  ];
  return <MenuDialog x={x} y={y} label={t("browser.ctx.actionsFor", { name: entry.name })} items={items} onAnswer={onAnswer} />;
}

/** Choice between uploading files and uploading folders (one toolbar button, no extra icon). */
export function UploadMenu({ x, y, onAnswer }: { x: number; y: number; onAnswer: (action: "upload" | "uploadFolder" | null) => void }) {
  const t = useT();
  return <MenuDialog x={x} y={y} label={t("browser.action.upload")} items={[{ action: "upload" as const, label: t("browser.uploadFiles") }, { action: "uploadFolder" as const, label: t("browser.uploadFolder") }]} onAnswer={onAnswer} />;
}

function MenuDialog<A extends string>({ x, y, label, items, onAnswer }: { x: number; y: number; label: string; items: { action: A; label: string; disabled?: boolean; title?: string }[]; onAnswer: (action: A | null) => void }) {
  const dialog = useModal();
  return <dialog ref={dialog} className="browser-context-menu" style={{ left: Math.max(8, Math.min(x, window.innerWidth - 280)), top: Math.max(8, Math.min(y, window.innerHeight - 200)) }} aria-label={label} onCancel={event => { event.preventDefault(); onAnswer(null); }} onClick={event => { if (event.target === event.currentTarget) onAnswer(null); }}>
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
