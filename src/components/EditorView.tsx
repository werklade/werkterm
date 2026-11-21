import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { errorCode, errorText } from "../lib/backendError";
import { invoke } from "@tauri-apps/api/core";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Facet, Prec, type Range } from "@codemirror/state";
import { Decoration, EditorView as CodeMirrorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { indentWithTab, undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { LanguageDescription, foldNodeProp, foldService, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { openSearchPanel } from "@codemirror/search";
import { designEditorExtensions } from "../lib/designEditorTheme";
import { Icon, type IconName } from "./Icon";
import { useModal } from "./useModal";
import { colorCodeMatches, mixColor, parseColor, textColor } from "../lib/colorCodes";
import { initialEol, eolChanged, mostFrequentEol } from "../lib/editorEol";
import { braceFold, indentationFold } from "../lib/editorFolding";
import { languageDisplayName, languageFromKnownFile, languageFromShebang } from "../lib/editorLanguage";
import { codeMirrorPhrases } from "../lib/editorPhrases";
import { formatShortcut } from "../lib/formatShortcut";
import { useLanguage, useT, type TextKey } from "../i18n";
import type { EditorDocument, EditorEol } from "../lib/editorTypes";
import "./EditorView.css";

import { accumulateZoomWheel, effectiveFontSize, initialZoomWheel, nextZoomOffset, offsetAfterResetToken } from "../lib/fontZoom";
import { registerPinchTarget } from "../lib/pinchZoom";
import { selectedTheme, type Settings } from "../lib/settings";
import { emojiFallback } from "../lib/terminalThemes";

export interface EditorHandle { save(): Promise<boolean>; isDirty(): boolean; lock(): Promise<void>; unlock(): void }
interface EditorViewProps {
  settings: Settings;
  /** Changes whenever "Schrift Standard" is chosen; clears this tab's zoom offset. */
  fontResetToken?: number;
  document: EditorDocument;
  onDirtyChange(dirty: boolean): void;
  onStatusChange(status: string): void;
  onDocumentChange?(document: EditorDocument): void;
}
type ChoiceId = "overwrite" | "reload" | "cancel";
const choiceLabels: Record<ChoiceId, TextKey> = { overwrite: "editor.choice.overwrite", reload: "editor.choice.reload", cancel: "common.cancel" };
interface Choice { title: string; choices: ChoiceId[]; resolve(value: ChoiceId): void }
const errorCodes = ["SUDO_INACTIVE", "SESSION_CLOSED", "ENCODING", "BINARY", "TOO_LARGE", "CONFLICT"] as const;

function EditorChoice({ choice, onAnswer }: { choice: Choice; onAnswer(value: ChoiceId): void }) {
  const t = useT();
  const dialog = useModal();
  return <dialog ref={dialog} className="editor-dialog" aria-modal="true" aria-label={choice.title} onCancel={event => { event.preventDefault(); onAnswer("cancel"); }}>
    <p>{choice.title}</p><div>{choice.choices.map((value, index) => <button type="button" key={value} autoFocus={index === choice.choices.length - 1} onClick={() => onAnswer(value)}>{t(choiceLabels[value])}</button>)}</div>
  </dialog>;
}

const editorBackground = Facet.define<string, string>({ combine: values => values[0] ?? "#000000" });

function decorations(view: CodeMirrorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const background = parseColor(view.state.facet(editorBackground)) ?? parseColor("#000000")!;
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
    if (update.docChanged || update.viewportChanged || update.transactions.length > 0) this.decorations = decorations(update.view);
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

const eolLabels: Record<EditorEol, string> = { lf: "LF", crLf: "CRLF", cr: "CR" };

const EditorView = forwardRef<EditorHandle, EditorViewProps>(function EditorView(props, ref) {
  const t = useT(), uiLanguage = useLanguage();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<CodeMirrorView | null>(null);
  const callbacks = useRef(props); callbacks.current = props;
  const loaded = useRef(props.document);
  const savedText = useRef(props.document.text);
  const target = useRef<EditorEol | null>(initialEol(props.document.eol));
  /** CodeMirror language name; null = plain text. Translated only for display (languageDisplayName). */
  const language = useRef<string | null>(null);
  const phrasesCompartment = useRef(new Compartment());
  const dirty = useRef(false);
  const locks = useRef(0);
  const [locked, setLocked] = useState(false);
  const saving = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  const chooseRef = useRef<Choice | null>(null);
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  const languageCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const preferencesCompartment = useRef(new Compartment());
  const readonlyCompartment = useRef(new Compartment());
  const languageRequest = useRef(0);
  // Per-tab font size offset against settings.editorFontSize; memory only.
  const zoomOffset = useRef(0);
  const zoomBy = useRef<(steps: number) => void>(() => undefined);
  const [eol, setEol] = useState(target.current);
  const [wrap, setWrap] = useState(props.settings.editorWrap);
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
    callbacks.current.onStatusChange(`${t("editor.status.position", { line: line.number, column: cursor - line.from + 1 })}${count ? ` (${t("editor.status.selected", { count })})` : ""} · UTF-8${loaded.current.bom ? " BOM" : ""} · ${target.current ? eolLabels[target.current] : t("editor.status.mixed")} · ${languageDisplayName(language.current)}${loaded.current.readonly ? ` · ${t("editor.status.readonly")}` : ""}`);
    const changed = editor.state.doc.toString() !== savedText.current || eolChanged(loaded.current.eol, target.current);
    dirty.current = changed;
    callbacks.current.onDirtyChange(changed);
    setHistoryState({ undo: undoDepth(editor.state) > 0, redo: redoDepth(editor.state) > 0 });
  }
  function selectEol(value: EditorEol) {
    if (loaded.current.readonly || saving.current || locks.current) return;
    target.current = value; setEol(value); report();
  }
  function ask(title: string, choices: ChoiceId[]): Promise<ChoiceId> {
    return new Promise(resolve => {
      const next = { title, choices, resolve };
      chooseRef.current = next; setChoice(next);
    });
  }
  function resolveChoice(value: ChoiceId) {
    const pending = chooseRef.current; chooseRef.current = null; setChoice(null); pending?.resolve(value);
  }
  function fail(error: unknown) {
    // Known codes stand alone (WRITE_FAILED carries the backup path as args.backup); anything else gets the save prefix.
    const code = errorCode(error);
    const known = code !== undefined && ((errorCodes as readonly string[]).includes(code) || code === "WRITE_FAILED" || code === "WRITE_FAILED_NO_BACKUP");
    const readable = known ? errorText(error) : t("editor.saveFailed", { message: errorText(error) });
    if (mounted.current) { setNotice(readable); callbacks.current.onStatusChange(readable); }
  }
  async function performSave(): Promise<boolean> {
    const editor = view.current;
    if (!editor || loaded.current.readonly) return false;
    const desiredEol = target.current;
    if (!desiredEol) { setNotice(t("editor.mixedTargetRequired")); return false; }
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
          if (errorCode(error) !== "CONFLICT") throw error;
          const action = await ask(t("editor.conflict.title"), ["overwrite", "reload", "cancel"]);
          if (!mounted.current || action === "cancel") return false;
          if (action === "overwrite") { force = true; continue; }
          if (await ask(t("editor.conflict.confirmReload"), ["reload", "cancel"]) !== "reload") return false;
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
    const shebang = languageFromKnownFile(document.name) ?? languageFromShebang(document.text);
    const description = LanguageDescription.matchFilename(languages, document.name) ?? (shebang ? LanguageDescription.matchLanguageName(languages, shebang, true) : null);
    language.current = description?.name ?? null;
    editor.dispatch({ effects: languageCompartment.current.reconfigure([]) });
    report();
    if (description) void description.load().then(support => {
      if (mounted.current && languageRequest.current === request) { editor.dispatch({ effects: languageCompartment.current.reconfigure(support) }); report(); }
    }).catch(() => { if (mounted.current && languageRequest.current === request) setNotice(t("editor.highlightFailed")); });
  }

  function preferenceExtensions(settings: Settings) {
    const theme = selectedTheme(settings);
    return [editorBackground.of(theme.background), ...designEditorExtensions(settings), CodeMirrorView.theme({
      ".cm-scroller": { fontSize: `${effectiveFontSize(settings.editorFontSize, zoomOffset.current)}px`, fontFamily: settings.fontFamily + emojiFallback },
    }), EditorState.tabSize.of(settings.editorTabSize)];
  }
  zoomBy.current = steps => {
    const settings = callbacks.current.settings;
    zoomOffset.current = nextZoomOffset(settings.editorFontSize, zoomOffset.current, steps);
    view.current?.dispatch({ effects: preferencesCompartment.current.reconfigure(preferenceExtensions(settings)) });
    callbacks.current.onStatusChange(t("editor.fontSize", { size: effectiveFontSize(settings.editorFontSize, zoomOffset.current) }));
  };
  const seenResetToken = useRef(props.fontResetToken ?? 0);
  useEffect(() => {
    // Runs before the settings effect below, so a reset together with a settings change applies once.
    const next = offsetAfterResetToken(seenResetToken.current, props.fontResetToken ?? 0, zoomOffset.current);
    seenResetToken.current = next.seen; zoomOffset.current = next.offset;
  }, [props.fontResetToken]);
  useEffect(() => {
    view.current?.dispatch({ effects: preferencesCompartment.current.reconfigure(preferenceExtensions(props.settings)) });
  }, [props.settings, props.fontResetToken]);
  useEffect(() => {
    // Language switch at runtime: swap the CodeMirror phrase map and redraw the status bar text.
    view.current?.dispatch({ effects: phrasesCompartment.current.reconfigure(EditorState.phrases.of(codeMirrorPhrases())) });
    report();
  }, [uiLanguage]);
  useEffect(() => {
    setWrap(props.settings.editorWrap);
    view.current?.dispatch({ effects: wrapCompartment.current.reconfigure(props.settings.editorWrap ? CodeMirrorView.lineWrapping : []) });
  }, [props.settings.editorWrap]);

  function editorExtensions(readonly: boolean) {
    return [
      basicSetup, preferencesCompartment.current.of(preferenceExtensions(props.settings)), colorPlugin, indentationPlugin, fallbackFolding,
      readonlyCompartment.current.of([EditorState.readOnly.of(readonly || locks.current > 0), CodeMirrorView.editable.of(!readonly && !locks.current)]),
      EditorState.transactionFilter.of(transaction => locks.current && transaction.docChanged ? [] : transaction),
      languageCompartment.current.of([]), wrapCompartment.current.of(wrap ? CodeMirrorView.lineWrapping : []),
      Prec.highest(keymap.of([
        { key: "Mod-s", run: () => { void saveRef.current(); return true; } },
        { key: "Mod-h", run: (current: CodeMirrorView) => { openSearchPanel(current); current.dom.querySelector<HTMLInputElement>('input[name="replace"]')?.focus(); return true; } },
        indentWithTab,
      ])),
      phrasesCompartment.current.of(EditorState.phrases.of(codeMirrorPhrases())),
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
    const hostElement = host.current;
    let zoomWheel = initialZoomWheel;
    const zoom = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault(); event.stopPropagation();
      const result = accumulateZoomWheel(zoomWheel, event.deltaY, event.deltaMode, event.timeStamp);
      zoomWheel = result.state;
      if (result.steps !== 0) zoomBy.current(result.steps);
    };
    hostElement.addEventListener("wheel", zoom, { capture: true, passive: false });
    // Touchpad pinch on Linux (backend event, see lib/pinchZoom): only while this editor has the focus.
    const unregisterPinch = registerPinchTarget({ element: hostElement, zoomBy: steps => zoomBy.current(steps) });
    return () => { hostElement.removeEventListener("wheel", zoom, { capture: true }); unregisterPinch(); languageRequest.current++; mounted.current = false; chooseRef.current?.resolve("cancel"); chooseRef.current = null; editor.destroy(); view.current = null; };
  }, []);

  function toggleWrap() {
    const next = !wrap; setWrap(next);
    view.current?.dispatch({ effects: wrapCompartment.current.reconfigure(next ? CodeMirrorView.lineWrapping : []) });
  }
  function button(icon: IconName, title: string, action: () => void, disabled = false, pressed?: boolean) {
    return <button type="button" title={title} aria-label={title} disabled={disabled} aria-pressed={pressed} onClick={action}><Icon name={icon} /></button>;
  }
  const shortcut = (...parts: string[]) => formatShortcut(parts);
  return <section className="editor-view" aria-label={t("editor.title", { name: props.document.name })}>
    <div className="editor-toolbar" role="toolbar" aria-label={t("editor.toolbar")}>
      {button("save", t("editor.save", { shortcut: shortcut("ctrl", "S") }), () => { void saveRef.current(); }, busy || locked || loaded.current.readonly || !eol)}
      {button("undo", t("editor.undo", { shortcut: shortcut("ctrl", "Z") }), () => { if (view.current && !locks.current) undo(view.current); }, locked || loaded.current.readonly || !historyState.undo)}
      {button("redo", t("editor.redo", { shortcut: shortcut("ctrl", "shift", "Z") }), () => { if (view.current && !locks.current) redo(view.current); }, locked || loaded.current.readonly || !historyState.redo)}
      {button("search", t("editor.search", { find: shortcut("ctrl", "F"), replace: shortcut("ctrl", "H") }), () => { if (view.current) openSearchPanel(view.current); })}
      {button("wrap", t("editor.wrap"), toggleWrap, false, wrap)}
      <span className="editor-toolbar-separator" role="separator" />
      {button("windows", t("editor.eol.crLf"), () => selectEol("crLf"), busy || locked || loaded.current.readonly, eol === "crLf")}
      {button("tux", t("editor.eol.lf"), () => selectEol("lf"), busy || locked || loaded.current.readonly, eol === "lf")}
      {button("apple", t("editor.eol.cr"), () => selectEol("cr"), busy || locked || loaded.current.readonly, eol === "cr")}
      {busy && <span>{t("editor.saving")}</span>}
    </div>
    {loaded.current.readonly && <div className="editor-notice">{t("editor.readonlyNotice")}</div>}
    {loaded.current.eol === "mixed" && !eol && <div className="editor-notice">{t("editor.mixedNotice", { lf: loaded.current.eolCounts.lf, crLf: loaded.current.eolCounts.crLf, cr: loaded.current.eolCounts.cr })} <button disabled={locked || loaded.current.readonly} onClick={() => selectEol(mostFrequentEol(loaded.current.eolCounts))}>{t("editor.unify")}</button></div>}
    {notice && <div className="editor-notice editor-error" role="alert">{notice}</div>}
    <div ref={host} className="editor-code" />
    {choice && <EditorChoice key={choice.title} choice={choice} onAnswer={resolveChoice} />}
  </section>;
});
export default EditorView;
