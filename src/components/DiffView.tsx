import { useEffect, useRef, useState } from "react";
import { MergeView, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { designEditorExtensions } from "../lib/designEditorTheme";
import { type Settings } from "../lib/settings";
import { emojiFallback } from "../lib/terminalThemes";
import { languageFromKnownFile, languageFromShebang } from "../lib/editorLanguage";
import { diffConfig, diffError, loadDiffPair, sourceLabel, whitespaceAvailable, type DiffPair, type DiffSource } from "../lib/diff";
import { tp, useLanguage, useT } from "../i18n";
import { codeMirrorPhrases } from "../lib/editorPhrases";
import "./DiffView.css";
export default function DiffView({ pair: initial, settings, onOpen }: { pair: DiffPair; settings: Settings; onOpen(source: DiffSource): void }) {
  const t = useT(), uiLanguage = useLanguage();
  const [pair, setPair] = useState(initial), [ignore, setIgnore] = useState(false), [collapse, setCollapse] = useState(false);
  const [count, setCount] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const canIgnore = whitespaceAvailable(pair.documents.map(document => document.size));
  const host = useRef<HTMLDivElement>(null), merge = useRef<MergeView | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: "0", "aria-readonly": "true" }),
      ...designEditorExtensions(settings), EditorState.phrases.of(codeMirrorPhrases()),
      EditorState.tabSize.of(settings.editorTabSize), keymap.of([{ key: "Alt-ArrowUp", run: goToPreviousChunk }, { key: "Alt-ArrowDown", run: goToNextChunk }]),
      EditorView.theme({ ".cm-scroller": { fontFamily: settings.fontFamily + emojiFallback, fontSize: `${settings.editorFontSize}px` } })];
    const compartments = [new Compartment(), new Compartment()];
    const view = new MergeView({ parent: host.current,
      a: { doc: pair.documents[0].text, extensions: [...extensions, compartments[0].of([])] },
      b: { doc: pair.documents[1].text, extensions: [...extensions, compartments[1].of([])] },
      diffConfig: diffConfig(ignore && canIgnore), collapseUnchanged: collapse ? { margin: 3, minSize: 4 } : undefined });
    merge.current = view; setCount(view.chunks.length);
    let disposed = false;
    pair.documents.forEach((document, index) => {
      const language = LanguageDescription.matchFilename(languages, document.name) ?? languages.find(l => l.name.toLowerCase() === (languageFromKnownFile(document.name) ?? languageFromShebang(document.text)));
      if (language) void language.load().then(extension => {
        if (!disposed) (index ? view.b : view.a).dispatch({ effects: compartments[index].reconfigure(extension) });
      }).catch(() => { /* Plain text remains usable if optional highlighting cannot load. */ });
    });
    return () => { disposed = true; merge.current = null; view.destroy(); };
  }, [pair, settings, ignore, collapse, canIgnore, uiLanguage]);
  const navigate = (next: boolean) => { const m = merge.current; if (!m) return; const view = m.b.hasFocus ? m.b : m.a; (next ? goToNextChunk : goToPreviousChunk)(view); view.focus(); };
  const reload = async () => {
    if (busy) return; setBusy(true); setError("");
    try { const next = await loadDiffPair(pair.sources); if (alive.current) setPair(next); }
    catch (reason) { if (alive.current) setError(diffError(reason)); }
    finally { if (alive.current) setBusy(false); }
  };
  return <section className="diff-view" aria-label={t("diff.view")}>
    <div className="diff-toolbar" role="toolbar" aria-label={t("diff.toolbar")}>
      <button onClick={() => navigate(false)} disabled={!count}>{t("diff.previous")}</button><button onClick={() => navigate(true)} disabled={!count}>{t("diff.next")}</button>
      <label title={canIgnore ? undefined : t("diff.whitespaceUnavailable")}><input type="checkbox" disabled={!canIgnore} checked={ignore && canIgnore} onChange={e => setIgnore(e.target.checked)} />{t("diff.ignoreWhitespace")}</label>
      <label><input type="checkbox" checked={collapse} onChange={e => setCollapse(e.target.checked)} />{t("diff.collapse")}</label>
      <button disabled={busy} onClick={() => setPair(p => ({ sources: [p.sources[1], p.sources[0]], documents: [p.documents[1], p.documents[0]] }))}>{t("diff.swap")}</button>
      <button disabled={busy} onClick={() => void reload()}>{t("diff.reload")}</button><span role="status">{tp("diff.count", count)}{count === 0 ? ` · ${t("diff.identical")}` : ""}</span>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="diff-headers">{pair.sources.map((source, i) => <header key={i}><span title={sourceLabel(source)}>{sourceLabel(source)}</span><small>UTF-8{pair.documents[i].bom ? " BOM" : ""} · {pair.documents[i].eol.toUpperCase()}</small><button onClick={() => onOpen(source)}>{t("diff.openInEditor")}</button></header>)}</div>
    {(pair.documents[0].bom !== pair.documents[1].bom || pair.documents[0].eol !== pair.documents[1].eol) && <small>{t("diff.encodingNote")}</small>}
    <div className="diff-host" ref={host} />
  </section>;
}
