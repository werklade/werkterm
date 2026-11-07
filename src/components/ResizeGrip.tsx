import { useRef, type PointerEvent } from "react";
interface Props {
  label: string;
  value: number;
  min: number;
  measure?(): number;
  max?: number;
  onResize(value: number): void;
  onAuto(): void;
  className?: string;
}
export function ResizeGrip({ label, value, min, max, measure, onResize, onAuto, className = "" }: Props) {
  const drag = useRef<{ x: number; value: number } | null>(null);
  const update = (next: number) => onResize(Math.max(min, Math.min(max ?? Infinity, next)));
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className={"resize-grip " + className} role="separator" aria-label={label}
    aria-orientation="vertical" aria-valuenow={Math.round(value)} aria-valuemin={min}
    aria-valuemax={max === undefined ? undefined : Math.round(max)} tabIndex={0}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); drag.current = { x: event.clientX, value: measure?.() ?? value }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (drag.current) update(drag.current.value + event.clientX - drag.current.x); }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { drag.current = null; }}
    onClick={event => event.stopPropagation()}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); onAuto(); }}
    onKeyDown={event => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); update((measure?.() ?? value) + (event.key === "ArrowRight" ? 10 : -10)); }
      if (event.key === "Home") { event.preventDefault(); onAuto(); }
    }} />;
}
