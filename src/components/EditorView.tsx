import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec, type Range } from "@codemirror/state";
import { Decoration, EditorView as CodeMirrorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { indentWithTab, undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { LanguageDescription, HighlightStyle, foldNodeProp, foldService, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { openSearchPanel } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { tags } from "@lezer/highlight";
import { Icon, type IconName } from "./Icon";
import { useModal } from "./useModal";
import { colorCodeMatches, EDITOR_BACKGROUND, mixColor, parseColor, textColor } from "../lib/colorCodes";
import { initialEol, eolChanged, mostFrequentEol } from "../lib/editorEol";
import { braceFold, indentationFold } from "../lib/editorFolding";
import { languageFromShebang } from "../lib/editorLanguage";
import type { EditorDocument, EditorEol } from "../lib/editorTypes";
import "./EditorView.css";

export interface EditorHandle { save(): Promise<boolean>; isDirty(): boolean; lock(): Promise<void>; unlock(): void }
interface EditorViewProps {
  document: EditorDocument;
  onDirtyChange(dirty: boolean): void;
  onStatusChange(status: string): void;
  onDocumentChange?(document: EditorDocument): void;
}
interface Choice { title: string; choices: string[]; resolve(value: string): void }

function EditorChoice({ choice, onAnswer }: { choice: Choice; onAnswer(value: string): void }) {
  const dialog = useModal();
  return <dialog ref={dialog} className="editor-dialog" aria-modal="true" aria-label={choice.title} onCancel={event => { event.preventDefault(); onAnswer("Abbrechen"); }}>
    <p>{choice.title}</p><div>{choice.choices.map((value, index) => <button type="button" key={value} autoFocus={index === choice.choices.length - 1} onClick={() => onAnswer(value)}>{value}</button>)}</div>
  </dialog>;
}

function decorations(view: CodeMirrorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const background = parseColor(EDITOR_BACKGROUND)!;
  for (const { from, to } of view.visibleRanges) {
    // Include adjacent characters only to validate word boundaries, never decorate outside visibleRanges.
    const start = Math.max(0, from - 1), end = Math.min(view.state.doc.length, to + 1);
    for (const match of colorCodeMatches(view.state.doc.sliceString(start, end))) {
      if (start + match.from < from || start + match.to > to) continue;
      const color = mixColor(match.color, background);
      ranges.push(Decoration.mark({ class: "cm-color-code", attributes: { style: `background-color:rgb(${color.r},${color.g},${color.b});--color-code-text:${textColor(color)}` } }).range(start + match.from, start + match.to));
    }
  }
  return Decoration.set(ranges, true);
}
const colorPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: CodeMirrorView) { this.decorations = decorations(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) this.decorations = decorations(update.view);
  }
}, { decorations: plugin => plugin.decorations });

function indentationDecorations(view: CodeMirrorView): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const seen = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    for (let position = view.state.doc.lineAt(from).from; position <= to;) {
      const line = view.state.doc.lineAt(position);
      const whitespace = /^[\t ]+/.exec(line.text)?.[0];
      if (whitespace && !seen.has(line.from)) {
        const start = Math.max(from, line.from), end = Math.min(to, line.from + whitespace.length);
        if (end > start) marks.push(Decoration.mark({ class: "cm-indent-guide" }).range(start, end));
        seen.add(line.from);
      }
      if (line.to === view.state.doc.length) break;
      position = line.to + 1;
    }
  }
  return Decoration.set(marks, true);
}
const indentationPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: CodeMirrorView) { this.decorations = indentationDecorations(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) this.decorations = indentationDecorations(update.view);
  }
}, { decorations: plugin => plugin.decorations });

const fallbackFolding = foldService.of((state, start, end) => {
  // foldService precedes parser folding in CM6: explicitly ask syntax nodes first.
  const tree = syntaxTree(state);
  let found: { from: number; to: number } | null = null;
  for (let stack: ReturnType<typeof tree.resolveStack> | null = tree.resolveStack(end, 1); stack; stack = stack.next) {
    const node = stack.node;
    if (node.from > end || node.to <= end) continue;
    const fold = node.type.prop(foldNodeProp)?.(node, state);
    if (found && node.from < start) break;
    if (fold && fold.from >= start && fold.from <= end && fold.to > end) found = fold;
  }
  if (found) return found;
  const text = state.doc.toString();
  return braceFold(text, start) ?? indentationFold(text, start);
});

const appTheme = CodeMirrorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg-content)", color: "#d4d4d4" },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)", fontSize: "14px" },
  ".cm-gutters": { backgroundColor: "var(--bg-content)", borderRight: "1px solid #3c3c3c", color: "#7a7a7a" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#181818" },
  ".cm-line": { padding: "0 6px" },
  ".cm-content": { caretColor: "#d4d4d4" },
}, { dark: true });
const comments = syntaxHighlighting(HighlightStyle.define([{ tag: tags.comment, color: "#829b7a", fontStyle: "italic" }]));
const eolLabels: Record<EditorEol, string> = { lf: "LF", crLf: "CRLF", cr: "CR" };

const EditorView = forwardRef<EditorHandle, EditorViewProps>(function EditorView(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<CodeMirrorView | null>(null);
  const callbacks = useRef(props); callbacks.current = props;
  const loaded = useRef(props.document);
  const savedText = useRef(props.document.text);
  const target = useRef<EditorEol | null>(initialEol(props.document.eol));
  const language = useRef("Text");
  const dirty = useRef(false);
  const locks = useRef(0);
  const [locked, setLocked] = useState(false);
  const saving = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  const chooseRef = useRef<Choice | null>(null);
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  const languageCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const readonlyCompartment = useRef(new Compartment());
  const languageRequest = useRef(0);
  const [eol, setEol] = useState(target.current);
  const [wrap, setWrap] = useState(false);
  const [notice, setNotice] = useState("");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyState, setHistoryState] = useState({ undo: false, redo: false });

  function report() {
    const editor = view.current;
    if (!editor) return;
    const selection = editor.state.selection;
    const cursor = selection.main.head;
    const line = editor.state.doc.lineAt(cursor);
    const count = selection.ranges.reduce((n, range) => n + range.to - range.from, 0);
    callbacks.current.onStatusChange(`Z ${line.number}, Sp ${cursor - line.from + 1}${count ? ` (${count} ausgewählt)` : ""} · UTF-8${loaded.current.bom ? " BOM" : ""} · ${target.current ? eolLabels[target.current] : "Gemischt"} · ${language.current}${loaded.current.readonly ? " · Schreibgeschützt" : ""}`);
    const changed = editor.state.doc.toString() !== savedText.current || eolChanged(loaded.current.eol, target.current);
    dirty.current = changed;
    callbacks.current.onDirtyChange(changed);
    setHistoryState({ undo: undoDepth(editor.state) > 0, redo: redoDepth(editor.state) > 0 });
  }
  function selectEol(value: EditorEol) {
    if (loaded.current.readonly || saving.current || locks.current) return;
    target.current = value; setEol(value); report();
  }
  function ask(title: string, choices: string[]): Promise<string> {
    return new Promise(resolve => {
      const next = { title, choices, resolve };
      chooseRef.current = next; setChoice(next);
    });
  }
  function resolveChoice(value: string) {
    const pending = chooseRef.current; chooseRef.current = null; setChoice(null); pending?.resolve(value);
  }
  function fail(error: unknown) {
    const message = String(error);
    const labels: Record<string, string> = { SUDO_INACTIVE: "sudo-Modus ist nicht mehr aktiv. Aktivieren Sie ihn in der SSH-Sitzung erneut. Ihr Inhalt bleibt im Editor erhalten.", SESSION_CLOSED: "Die SSH-Sitzung ist geschlossen. Der Editor bleibt mit Ihrem Inhalt geöffnet.", ENCODING: "Die Datei ist nicht als UTF-8 kodiert.", BINARY: "Binärdateien können nicht bearbeitet werden.", TOO_LARGE: "Die Datei ist größer als 10 MB." };
    const prefix = message.split(":", 1)[0];
    const readable = prefix === "WRITE_FAILED" ? message.slice("WRITE_FAILED: ".length) : labels[prefix] ?? `Speichern fehlgeschlagen: ${message}`;
    if (mounted.current) { setNotice(readable); callbacks.current.onStatusChange(readable); }
  }
  async function performSave(): Promise<boolean> {
    const editor = view.current;
    if (!editor || loaded.current.readonly) return false;
    const desiredEol = target.current;
    if (!desiredEol) { setNotice("Bitte zuerst ein Ziel für die gemischten Zeilenenden wählen."); return false; }
    setBusy(true);
    // Snapshot ensures typing during the request cannot accidentally mark unsaved text clean.
    const text = editor.state.doc.toString();
    const original = loaded.current;
    let force = false;
    try {
      for (;;) {
        try {
          const result = await invoke<{ size: number; mtime: number | null }>("editor_save", { docId: original.docId, text, eol: desiredEol, bom: original.bom, force });
          if (!mounted.current) return false;
          const counts = { lf: 0, crLf: 0, cr: 0 }; counts[desiredEol] = text.split("\n").length - 1;
          const document = { ...original, ...result, text, eol: desiredEol, eolCounts: counts };
          loaded.current = document; savedText.current = text;
          callbacks.current.onDocumentChange?.(document); setNotice(""); report();
          return !dirty.current;
        } catch (error) {
          if (!String(error).startsWith("CONFLICT:")) throw error;
          const action = await ask("Datei wurde auf dem Server geändert", ["Überschreiben", "Neu laden", "Abbrechen"]);
          if (!mounted.current || action === "Abbrechen") return false;
          if (action === "Überschreiben") { force = true; continue; }
          if (await ask("Lokale Änderungen verwerfen und Datei neu laden?", ["Neu laden", "Abbrechen"]) !== "Neu laden") return false;
          setLock(true);
          try {
            const document = await invoke<EditorDocument>("editor_reload", { docId: original.docId });
            if (!mounted.current) return false;
            loaded.current = document; savedText.current = document.text;
            target.current = initialEol(document.eol); setEol(target.current);
            editor.setState(EditorState.create({ doc: document.text, extensions: editorExtensions(document.readonly) }));
            loadLanguage(document);
            callbacks.current.onDocumentChange?.(document); setNotice(""); report();
          } finally { setLock(false); }
          return false;
        }
      }
    } catch (error) { fail(error); return false; }
    finally { if (mounted.current) setBusy(false); }
  }
  saveRef.current = () => {
    if (!saving.current) saving.current = performSave().finally(() => { saving.current = null; });
    return saving.current;
  };
  function setLock(value: boolean) {
    locks.current = Math.max(0, locks.current + (value ? 1 : -1));
    if (!mounted.current) return;
    setLocked(locks.current > 0);
    const readonly = loaded.current.readonly || locks.current > 0;
    view.current?.dispatch({ effects: readonlyCompartment.current.reconfigure([EditorState.readOnly.of(readonly), CodeMirrorView.editable.of(!readonly)]) });
  }
  useImperativeHandle(ref, () => ({
    save: () => saveRef.current(),
    isDirty: () => dirty.current,
    lock: async () => { setLock(true); await saving.current; },
    unlock: () => setLock(false),
  }), []);

  function loadLanguage(document: EditorDocument) {
    const editor = view.current;
    if (!editor) return;
    const request = ++languageRequest.current;
    const shebang = languageFromShebang(document.text);
    const description = LanguageDescription.matchFilename(languages, document.name) ?? (shebang ? LanguageDescription.matchLanguageName(languages, shebang, true) : null);
    language.current = description?.name ?? "Text";
    editor.dispatch({ effects: languageCompartment.current.reconfigure([]) });
    report();
    if (description) void description.load().then(support => {
      if (mounted.current && languageRequest.current === request) { editor.dispatch({ effects: languageCompartment.current.reconfigure(support) }); report(); }
    }).catch(() => { if (mounted.current && languageRequest.current === request) setNotice("Die Syntaxhervorhebung konnte nicht geladen werden."); });
  }

  function editorExtensions(readonly: boolean) {
    return [
      basicSetup, oneDark, Prec.highest(appTheme), Prec.highest(comments), colorPlugin, indentationPlugin, fallbackFolding,
      readonlyCompartment.current.of([EditorState.readOnly.of(readonly || locks.current > 0), CodeMirrorView.editable.of(!readonly && !locks.current)]),
      EditorState.transactionFilter.of(transaction => locks.current && transaction.docChanged ? [] : transaction),
      languageCompartment.current.of([]), wrapCompartment.current.of(wrap ? CodeMirrorView.lineWrapping : []),
      Prec.highest(keymap.of([
        { key: "Mod-s", run: () => { void saveRef.current(); return true; } },
        { key: "Mod-h", run: (current: CodeMirrorView) => { openSearchPanel(current); current.dom.querySelector<HTMLInputElement>('input[name="replace"]')?.focus(); return true; } },
        indentWithTab,
      ])),
      EditorState.phrases.of({ "Search": "Suchen", "Replace": "Ersetzen", "replace": "Ersetzen", "replace all": "Alle ersetzen", "next": "Weiter", "previous": "Zurück", "all": "Alle", "match case": "Groß-/Kleinschreibung", "by word": "Ganzes Wort", "regexp": "Regulärer Ausdruck", "close": "Schließen" }),
      CodeMirrorView.updateListener.of(update => { if (update.docChanged || update.selectionSet) report(); }),
    ];
  }

  useEffect(() => {
    if (!host.current) return;
    mounted.current = true;
    const document = loaded.current;
    const editor = new CodeMirrorView({ parent: host.current, state: EditorState.create({ doc: document.text, extensions: editorExtensions(document.readonly) }) });
    view.current = editor;
    loadLanguage(document);
    return () => { languageRequest.current++; mounted.current = false; chooseRef.current?.resolve("Abbrechen"); chooseRef.current = null; editor.destroy(); view.current = null; };
  }, []);

  function toggleWrap() {
    const next = !wrap; setWrap(next);
    view.current?.dispatch({ effects: wrapCompartment.current.reconfigure(next ? CodeMirrorView.lineWrapping : []) });
  }
  function button(icon: IconName, title: string, action: () => void, disabled = false, pressed?: boolean) {
    return <button type="button" title={title} aria-label={title} disabled={disabled} aria-pressed={pressed} onClick={action}><Icon name={icon} /></button>;
  }
  return <section className="editor-view" aria-label={`Editor: ${props.document.name}`}>
    <div className="editor-toolbar" role="toolbar" aria-label="Editor-Werkzeuge">
      {button("save", "Speichern (Strg+S)", () => { void saveRef.current(); }, busy || locked || loaded.current.readonly || !eol)}
      {button("undo", "Rückgängig (Strg+Z)", () => { if (view.current && !locks.current) undo(view.current); }, locked || loaded.current.readonly || !historyState.undo)}
      {button("redo", "Wiederholen (Strg+Umschalt+Z)", () => { if (view.current && !locks.current) redo(view.current); }, locked || loaded.current.readonly || !historyState.redo)}
      {button("search", "Suchen / Ersetzen (Strg+F / Strg+H)", () => { if (view.current) openSearchPanel(view.current); })}
      {button("wrap", "Zeilenumbruch ein-/ausschalten", toggleWrap, false, wrap)}
      <span className="editor-toolbar-separator" role="separator" />
      {button("windows", "Windows-Zeilenenden (CRLF)", () => selectEol("crLf"), busy || locked || loaded.current.readonly, eol === "crLf")}
      {button("tux", "Linux-Zeilenenden (LF)", () => selectEol("lf"), busy || locked || loaded.current.readonly, eol === "lf")}
      {button("apple", "Mac-Zeilenenden (CR)", () => selectEol("cr"), busy || locked || loaded.current.readonly, eol === "cr")}
      {busy && <span>Speichern …</span>}
    </div>
    {loaded.current.readonly && <div className="editor-notice">Schreibgeschützt – die Datei kann nicht geändert werden.</div>}
    {loaded.current.eol === "mixed" && !eol && <div className="editor-notice">Gemischte Zeilenenden (LF {loaded.current.eolCounts.lf}, CRLF {loaded.current.eolCounts.crLf}, CR {loaded.current.eolCounts.cr}) <button disabled={locked || loaded.current.readonly} onClick={() => selectEol(mostFrequentEol(loaded.current.eolCounts))}>Vereinheitlichen</button></div>}
    {notice && <div className="editor-notice editor-error" role="alert">{notice}</div>}
    <div ref={host} className="editor-code" />
    {choice && <EditorChoice key={choice.title} choice={choice} onAnswer={resolveChoice} />}
  </section>;
});
export default EditorView;
