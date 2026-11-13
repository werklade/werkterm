import { getLanguage, t, type TextKey } from "../i18n";

/** CodeMirror phrase (English source text) -> i18n key. Covers basicSetup, search, merge and lint panels. */
const phraseKeys: [string, string][] = [
  ["Find", "editor.cm.find"], ["Replace", "editor.cm.replaceField"], ["next", "editor.cm.next"], ["previous", "editor.cm.previous"],
  ["all", "editor.cm.all"], ["match case", "editor.cm.matchCase"], ["by word", "editor.cm.byWord"], ["regexp", "editor.cm.regexp"],
  ["replace", "editor.cm.replace"], ["replace all", "editor.cm.replaceAll"], ["close", "editor.cm.close"],
  ["Go to line", "editor.cm.goToLine"], ["go", "editor.cm.go"],
  ["replaced match on line $", "editor.cm.replacedMatch"], ["replaced $ matches", "editor.cm.replacedMatches"],
  ["current match", "editor.cm.currentMatch"], ["on line", "editor.cm.onLine"],
  ["Control character", "editor.cm.controlCharacter"],
  ["Folded lines", "editor.cm.foldedLines"], ["Unfolded lines", "editor.cm.unfoldedLines"], ["to", "editor.cm.to"],
  ["folded code", "editor.cm.foldedCode"], ["unfold", "editor.cm.unfold"], ["Fold line", "editor.cm.foldLine"], ["Unfold line", "editor.cm.unfoldLine"],
  ["Selection deleted", "editor.cm.selectionDeleted"], ["Completions", "editor.cm.completions"],
  ["$ unchanged lines", "editor.cm.unchangedLines"], ["Revert this chunk", "editor.cm.revertChunk"],
  ["Diagnostics", "editor.cm.diagnostics"], ["No diagnostics", "editor.cm.noDiagnostics"],
];

/** Phrase map for `EditorState.phrases` in the current language. English is CodeMirror's own text, so no map is needed. */
export function codeMirrorPhrases(): Record<string, string> {
  if (getLanguage() === "en") return {};
  return Object.fromEntries(phraseKeys.map(([phrase, key]) => [phrase, t(key as TextKey)]));
}
