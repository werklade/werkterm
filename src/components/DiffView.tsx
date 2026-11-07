import { useEffect, useRef, useState } from "react";
import { MergeView, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { LanguageDescription, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { selectedTheme, type Settings } from "../lib/settings";
import { luminance, parseColor } from "../lib/colorCodes";
import { emojiFallback } from "../lib/terminalThemes";
import { languageFromShebang } from "../lib/editorLanguage";
import { diffConfig, diffError, loadDiffPair, sourceLabel, type DiffPair, type DiffSource } from "../lib/diff";
import "./DiffView.css";
export default function DiffView({ pair: initial, settings, onOpen }: { pair: DiffPair; settings: Settings; onOpen(source: DiffSource): void }) {
  const [pair, setPair] = useState(initial), [ignore, setIgnore] = useState(false), [collapse, setCollapse] = useState(false);
  const [count, setCount] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const host = useRef<HTMLDivElement>(null), merge = useRef<MergeView | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!host.current) return;
    const theme = selectedTheme(settings), light = luminance(parseColor(theme.background)!) > 140;
    const extensions: Extension[] = [lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: "0", "aria-readonly": "true" }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }), light ? [] : oneDark,
      EditorState.tabSize.of(settings.editorTabSize), keymap.of([{ key: "Alt-ArrowUp", run: goToPreviousChunk }, { key: "Alt-ArrowDown", run: goToNextChunk }]),
      EditorView.theme({ "&": { backgroundColor: theme.background, color: theme.foreground },
        ".cm-scroller": { fontFamily: settings.fontFamily + emojiFallback, fontSize: `${settings.editorFontSize}px` },
        ".cm-gutters": { backgroundColor: theme.background, color: light ? "#666" : "#aaa" },
        ".cm-deletedLine": { backgroundColor: light ? "#ffe0e0" : "#602c36" },
        ".cm-insertedLine": { backgroundColor: light ? "#d9f4df" : "#254e37" },
        ".cm-deletedText": { backgroundColor: light ? "#ffb9b9" : "#8a3d4b" },
        ".cm-insertedText": { backgroundColor: light ? "#a4e4b3" : "#35724b" } }, { dark: !light })];
    const compartments = [new Compartment(), new Compartment()];
    const view = new MergeView({ parent: host.current,
      a: { doc: pair.documents[0].text, extensions: [...extensions, compartments[0].of([])] },
      b: { doc: pair.documents[1].text, extensions: [...extensions, compartments[1].of([])] },
      diffConfig: diffConfig(ignore), collapseUnchanged: collapse ? { margin: 3, minSize: 4 } : undefined });
    merge.current = view; setCount(view.chunks.length);
    let disposed = false;
    pair.documents.forEach((document, index) => {
      const language = LanguageDescription.matchFilename(languages, document.name) ?? languages.find(l => l.name.toLowerCase() === languageFromShebang(document.text));
      if (language) void language.load().then(extension => {
        if (!disposed) (index ? view.b : view.a).dispatch({ effects: compartments[index].reconfigure(extension) });
      }).catch(() => { /* Plain text remains usable if optional highlighting cannot load. */ });
    });
    return () => { disposed = true; merge.current = null; view.destroy(); };
  }, [pair, settings, ignore, collapse]);
  const navigate = (next: boolean) => { const m = merge.current; if (!m) return; const view = m.b.hasFocus ? m.b : m.a; (next ? goToNextChunk : goToPreviousChunk)(view); view.focus(); };
  const reload = async () => {
    if (busy) return; setBusy(true); setError("");
    try { const next = await loadDiffPair(pair.sources); if (alive.current) setPair(next); }
    catch (reason) { if (alive.current) setError(diffError(reason)); }
    finally { if (alive.current) setBusy(false); }
  };
  return <section className="diff-view" aria-label="Dateivergleich">
    <div className="diff-toolbar" role="toolbar" aria-label="Vergleichswerkzeuge">
      <button onClick={() => navigate(false)} disabled={!count}>Vorherige Änderung</button><button onClick={() => navigate(true)} disabled={!count}>Nächste Änderung</button>
      <label><input type="checkbox" checked={ignore} onChange={e => setIgnore(e.target.checked)} />Leerzeichen ignorieren</label>
      <label><input type="checkbox" checked={collapse} onChange={e => setCollapse(e.target.checked)} />Unveränderte einklappen</label>
      <button disabled={busy} onClick={() => setPair(p => ({ sources: [p.sources[1], p.sources[0]], documents: [p.documents[1], p.documents[0]] }))}>Seiten tauschen</button>
      <button disabled={busy} onClick={() => void reload()}>Neu laden</button><span role="status">{count} Unterschiede{count === 0 ? " · Dateien sind identisch" : ""}</span>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="diff-headers">{pair.sources.map((source, i) => <header key={i}><span title={sourceLabel(source)}>{sourceLabel(source)}</span><small>UTF-8{pair.documents[i].bom ? " BOM" : ""} · {pair.documents[i].eol.toUpperCase()}</small><button onClick={() => onOpen(source)}>Im Editor öffnen</button></header>)}</div>
    {(pair.documents[0].bom !== pair.documents[1].bom || pair.documents[0].eol !== pair.documents[1].eol) && <small>Hinweis: Kodierung oder Zeilenenden unterscheiden sich; der Vergleich verwendet LF-Text.</small>}
    <div className="diff-host" ref={host} />
  </section>;
}
