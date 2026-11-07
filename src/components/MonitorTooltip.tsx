import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
export function MonitorTooltip({ children, content }: { children: ReactNode; content: ReactNode }) {
  const id = useId(), anchor = useRef<HTMLSpanElement>(null), box = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 });
  const hovered = useRef(false), focused = useRef(false);
  function close() { clearTimeout(timer.current); if (!hovered.current && !focused.current) setOpen(false); }
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => { const a = anchor.current?.getBoundingClientRect(), b = box.current?.getBoundingClientRect(); if (!a || !b) return; setPosition({ left: Math.max(8, Math.min(a.left, window.innerWidth - b.width - 8)), top: Math.max(8, a.bottom + b.height + 8 < window.innerHeight ? a.bottom + 5 : a.top - b.height - 5) }); };
    place(); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    const observer = new ResizeObserver(place); if (box.current) observer.observe(box.current);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, content]);
  return <span ref={anchor} className="monitor-field" tabIndex={0} aria-describedby={open ? id : undefined} onMouseEnter={() => { hovered.current = true; timer.current = setTimeout(() => setOpen(true), 400); }} onMouseLeave={() => { hovered.current = false; close(); }} onFocus={() => { focused.current = true; clearTimeout(timer.current); setOpen(true); }} onBlur={() => { focused.current = false; close(); }} onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}>{children}{open && createPortal(<div ref={box} id={id} role="tooltip" className="monitor-tooltip" style={position}>{content}</div>, document.body)}</span>;
}
