import { useEffect, useRef, useState, type CSSProperties } from "react";
import { clampSplitRatio, type SplitMode } from "../lib/split";

export function paneStyle(mode: SplitMode, index: number, x: number, y: number): CSSProperties {
  const columns = mode === "columns" || mode === "quad";
  const rows = mode === "rows" || mode === "quad";
  const right = columns && index % 2 === 1;
  const bottom = rows && (mode === "rows" ? index === 1 : index > 1);
  return { position: "absolute", left: columns && right ? `${x}%` : 0, top: rows && bottom ? `${y}%` : 0,
    width: columns ? `${right ? 100 - x : x}%` : "100%", height: rows ? `${bottom ? 100 - y : y}%` : "100%" };
}
export function useSplitRatios() { return useState({ x: 50, y: 50 }); }
export function SplitLayout({ mode, panes, terminals, focusedIndex, ratios, onRatios, onAssign, onFocus, onNew }: {
  mode: SplitMode; panes: (number | null)[]; terminals: { id: number; title: string }[]; focusedIndex: number;
  ratios: { x: number; y: number }; onRatios(value: { x: number; y: number }): void;
  onAssign(index: number, id: number | null): void; onFocus(index: number): void; onNew(index: number): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<"x" | "y" | null>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = mode === "rows" ? ratios.x : clampSplitRatio(ratios.x, rect.width, 160);
      const y = mode === "columns" ? ratios.y : clampSplitRatio(ratios.y, rect.height, 100);
      if (x !== ratios.x || y !== ratios.y) onRatios({ x, y });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode, ratios, onRatios]);
  const resize = (axis: "x" | "y", value: number) => {
    const rect = root.current?.getBoundingClientRect();
    const size = axis === "x" ? rect?.width : rect?.height;
    onRatios({ ...ratios, [axis]: clampSplitRatio(value, size ?? 0, axis === "x" ? 160 : 100) });
  };
  const separator = (axis: "x" | "y") => <div role="separator" tabIndex={0} aria-label={axis === "x" ? "Spaltenbreite" : "Zeilenhöhe"}
    aria-orientation={axis === "x" ? "vertical" : "horizontal"} aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(ratios[axis])}
    className={`split-divider split-divider-${axis}`} style={axis === "x" ? { left: `${ratios.x}%` } : { top: `${ratios.y}%` }}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = axis; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => {
      if (drag.current !== axis || !root.current) return;
      const rect = root.current.getBoundingClientRect();
      const size = axis === "x" ? rect.width : rect.height;
      const value = (axis === "x" ? event.clientX - rect.left : event.clientY - rect.top) / size * 100;
      resize(axis, value);
    }}
    onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
    onDoubleClick={() => onRatios({ ...ratios, [axis]: 50 })}
    onKeyDown={event => { if (event.key === "Home") { event.preventDefault(); resize(axis, 50); } else if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) { event.preventDefault(); resize(axis, ratios[axis] + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -2 : 2)); } }} />;
  return <div ref={root} className="split-chrome">
    {panes.map((id, index) => <div key={index} className={`split-pane-chrome ${focusedIndex === index ? "focused" : ""}`} style={paneStyle(mode, index, ratios.x, ratios.y)}>
      <header className="split-pane-header"><select aria-label={`Terminal für Bereich ${index + 1}`} value={id ?? ""} onChange={event => onAssign(index, event.target.value === "" ? null : Number(event.target.value))}>
        <option value="">Terminal wählen</option>{terminals.map(tab => <option key={tab.id} value={tab.id}>{tab.title}</option>)}
      </select><button className="split-title" onClick={() => onFocus(index)}>{terminals.find(tab => tab.id === id)?.title ?? `Bereich ${index + 1}`}</button>
        <button aria-label={`Bereich ${index + 1} leeren`} onClick={() => onAssign(index, null)}>×</button></header>
      {id === null && <div className="split-empty" onPointerDown={() => onFocus(index)}><span>Terminal wählen</span><button onClick={() => onNew(index)}>Neues lokales Terminal</button></div>}
    </div>)}
    {mode !== "rows" && separator("x")}{mode !== "columns" && separator("y")}
  </div>;
}
