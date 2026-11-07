import { useEffect, useRef, useState } from "react";
import { menuMove, shortcutAction } from "../lib/menu";
export interface MenuItem { label: string; action: string; shortcut?: string; disabled?: boolean; tooltip?: string; checked?: boolean }
export interface AppMenu { label: string; mnemonic: number; items: MenuItem[] }
export function MenuBar({ menus, onAction }: { menus: AppMenu[]; onAction(action: string): void }) {
  const root = useRef<HTMLElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [item, setItem] = useState(-1);
  const [top, setTop] = useState(0);
  const close = (restore: boolean) => { setOpen(null); setItem(-1); if (restore) previous.current?.focus(); };
  const show = (index: number, last = false) => {
    if (open === null) previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTop(index); setOpen(index); setItem(menuMove(-1, last ? "End" : "Home", menus[index].items.map(entry => !!entry.disabled)));
  };
  useEffect(() => {
    if (open !== null) root.current?.querySelector<HTMLElement>(`[data-entry="${open}-${item}"]`)?.focus();
  }, [open, item]);
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) close(false); };
    const key = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const index = menus.findIndex(menu => menu.label[menu.mnemonic].toLowerCase() === e.key.toLowerCase());
        if (index >= 0) { e.preventDefault(); e.stopPropagation(); show(index); return; }
      }
      const action = shortcutAction(e, !!(e.target instanceof Element && e.target.closest(".terminal-panel")));
      if (action) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) { close(false); onAction(action); } }
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key, true); };
  });
  return <nav ref={root} className="menubar" role="menubar" aria-label="Hauptmenü" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close(false); }} onKeyDown={e => {
    const index = open ?? top;
    if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault(); const next = menuMove(index, e.key, menus.map(() => false));
      if (open !== null) show(next); else { setTop(next); root.current?.querySelector<HTMLElement>(`[data-top="${next}"]`)?.focus(); }
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault(); if (open === null) show(index, e.key === "ArrowUp"); else setItem(menuMove(item, e.key, menus[index].items.map(entry => !!entry.disabled)));
    } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === "Tab") close(false);
  }}>{menus.map((menu, index) => <div className="menu-root" key={menu.label}>
    <button role="menuitem" data-top={index} tabIndex={top === index ? 0 : -1} aria-haspopup="menu" aria-expanded={open === index} aria-controls={`app-menu-${index}`} onFocus={() => setTop(index)} onClick={() => open === index ? close(true) : show(index)}>{menu.label.slice(0, menu.mnemonic)}<u>{menu.label[menu.mnemonic]}</u>{menu.label.slice(menu.mnemonic + 1)}</button>
    {open === index && <div id={`app-menu-${index}`} className="app-menu" role="menu" aria-label={menu.label}>{menu.items.map((entry, i) => <button key={entry.action} data-entry={`${index}-${i}`} tabIndex={-1} role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={entry.checked} aria-disabled={entry.disabled || undefined} title={entry.tooltip} onFocus={() => setItem(i)} onClick={() => { if (entry.disabled) return; close(true); onAction(entry.action); }}><span>{entry.checked === undefined ? "" : entry.checked ? "✓ " : "　"}{entry.label}</span><kbd>{entry.shortcut}</kbd></button>)}</div>}
  </div>)}</nav>;
}
