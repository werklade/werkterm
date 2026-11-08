import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { getDesign, designColorScheme } from "./designs";
import { selectedTheme, type Settings } from "./settings";
export function designEditorExtensions(settings: Settings) {
    const design = getDesign(settings.design), e = design.editor, terminal = selectedTheme(settings);
    return [syntaxHighlighting(HighlightStyle.define([
            { tag: tags.keyword, color: e.keyword }, { tag: tags.string, color: e.string }, { tag: tags.comment, color: e.comment, fontStyle: "italic" },
            { tag: tags.number, color: e.number }, { tag: tags.function(tags.variableName), color: e.function }, { tag: tags.typeName, color: e.type },
            { tag: tags.variableName, color: e.variable }, { tag: tags.propertyName, color: e.property }, { tag: tags.operator, color: e.operator },
            { tag: tags.tagName, color: e.tag }, { tag: tags.attributeName, color: e.attribute }, { tag: tags.meta, color: e.meta }, { tag: tags.invalid, color: e.invalid },
        ])), EditorView.theme({
            "&": { height: "100%", backgroundColor: terminal.background, color: e.variable },
            ".cm-gutters": { backgroundColor: terminal.background, color: e["gutter-fg"], borderRight: "1px solid var(--border-strong)" },
            ".cm-content": { caretColor: e.cursor }, ".cm-cursor, .cm-dropCursor": { borderLeftColor: e.cursor },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: e["active-line"] },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: e.selection },
            ".cm-line": { padding: "0 6px" }, ".cm-scroller": { overflow: "auto" },
            ".cm-deletedLine": { backgroundColor: design.ui["diff-deleted"] }, ".cm-insertedLine": { backgroundColor: design.ui["diff-added"] },
            ".cm-deletedText": { backgroundColor: design.ui["diff-deleted-text"] }, ".cm-insertedText": { backgroundColor: design.ui["diff-added-text"] },
        }, { dark: designColorScheme(design) === "dark" })];
}
