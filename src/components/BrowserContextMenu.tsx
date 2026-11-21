import { useModal } from "./useModal";
import type { DirEntry } from "../lib/fs";
import { useT } from "../i18n";
export type ContextAction = "edit" | "download" | "chmod" | "rename" | "delete" | "remember" | "compare";
interface MenuItem<A extends string> { action: A; label: string; disabled?: boolean; title?: string; shortcut?: string }
/** `count` > 1: the menu acts on the whole multi-selection; single-entry actions are disabled. */
export function BrowserContextMenu({ entry, x, y, onAnswer, markedName, permissionsDisabled, permissionsTitle, renameDisabled, count = 1 }: { renameDisabled?: boolean; permissionsDisabled?: boolean; permissionsTitle?: string; markedName?: string; entry: DirEntry; x: number; y: number; count?: number; onAnswer: (action: ContextAction | null) => void }) {
  const t = useT();
  const file = entry.kind === "file" || (entry.kind === "symlink" && !entry.targetIsDir);
  const many = count > 1;
  const singleOnly = many ? { disabled: true, title: t("browser.singleOnly") } : {};
  const items: MenuItem<ContextAction>[] = [
    ...(file ? [{ action: "edit" as const, label: t("browser.action.edit"), ...singleOnly }] : []),
    ...(entry.kind === "file" || entry.kind === "dir" ? [{ action: "remember" as const, label: t("browser.ctx.remember"), ...singleOnly }, ...(markedName ? [{ action: "compare" as const, label: t("browser.ctx.compare", { name: markedName }), ...singleOnly }] : [])] : []),
    // Folders download recursively; links to folders are followed for the selected folder only.
    { action: "download", label: t("browser.action.download"), disabled: !many && entry.kind !== "file" && entry.kind !== "dir" && entry.kind !== "symlink" },
    // Several entries: symlinks among them are skipped, so only the entry itself does not decide.
    { action: "chmod", label: t("permissions.menu"), disabled: permissionsDisabled || (!many && entry.kind === "symlink"), title: permissionsDisabled ? permissionsTitle : undefined },
    { action: "rename", label: t("browser.action.rename"), disabled: renameDisabled, shortcut: "F2", ...singleOnly },
    { action: "delete", label: t("common.delete") },
  ];
  return <MenuDialog x={x} y={y} label={many ? t("browser.ctx.actionsForMany", { count }) : t("browser.ctx.actionsFor", { name: entry.name })} items={items} onAnswer={onAnswer} />;
}

/** Choice between uploading files and uploading folders (one toolbar button, no extra icon). */
export function UploadMenu({ x, y, onAnswer }: { x: number; y: number; onAnswer: (action: "upload" | "uploadFolder" | null) => void }) {
  const t = useT();
  return <MenuDialog x={x} y={y} label={t("browser.action.upload")} items={[{ action: "upload" as const, label: t("browser.uploadFiles") }, { action: "uploadFolder" as const, label: t("browser.uploadFolder") }]} onAnswer={onAnswer} />;
}

function MenuDialog<A extends string>({ x, y, label, items, onAnswer }: { x: number; y: number; label: string; items: MenuItem<A>[]; onAnswer: (action: A | null) => void }) {
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
    }}>{items.map((item, index) => <button key={item.action} autoFocus={index === 0} role="menuitem" title={item.title} disabled={item.disabled} aria-keyshortcuts={item.shortcut} onClick={() => onAnswer(item.action)}>{item.shortcut ? <><span>{item.label}</span><kbd>{item.shortcut}</kbd></> : item.label}</button>)}</div>
  </dialog>;
}
