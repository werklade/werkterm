import type { BrowserTab } from "../components/FileBrowser";

/** Browser navigation belongs to the editor tab, but file IO uses its terminal source. */
export function sourceForEditorOpen(browser: BrowserTab, original?: BrowserTab): BrowserTab {
  return original ? { ...browser, id: original.id, kind: original.kind } : browser;
}

export function editorFileKey(source: BrowserTab, path: string): string {
  if (source.kind === "ssh") return JSON.stringify(["ssh", source.sessionId, path]);
  return JSON.stringify([source.kind, source.kind === "wsl" ? source.cwd?.host : null, path]);
}

/** Retain local/WSL access after terminal closure; remote IO requires the live SSH tab. */
export function browserForEditor(editor: BrowserTab, source: BrowserTab, tabs: readonly BrowserTab[]): BrowserTab {
  const liveSource = tabs.find(tab => tab.id === source.id);
  const current = liveSource ?? { ...source, exited: source.kind === "ssh", sessionId: undefined };
  return { ...current, id: editor.id, browserPath: editor.browserPath };
}
