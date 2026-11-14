import { Change, Chunk, diff } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";
import type { BrowserTab } from "../components/FileBrowser";
import type { EditorDocument } from "./editorTypes";
import { t } from "../i18n";
import { errorCode, errorText } from "./backendError";
export interface DiffSource { tab: BrowserTab; path: string }
export interface DiffPair { sources: [DiffSource, DiffSource]; documents: [EditorDocument, EditorDocument] }
export const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
export const diffTitle = (a: string, b: string) => t("diff.title", { left: fileName(a), right: fileName(b) });
export const normalizeEol = (text: string) => text.replace(/\r\n?|\n/g, "\n");
export const whitespaceAvailable = (sizes: readonly number[]) => sizes.every(size => size <= 1024 * 1024);
export function normalizedWhitespace(text: string) {
  const positions = new Uint32Array(text.length + 1); let value = "", count = 0;
  for (let i = 0; i < text.length; i++) if (!/[^\S\n]/.test(text[i])) { positions[count++] = i; value += text[i]; }
  positions[count++] = text.length;
  return { value, positions: positions.subarray(0, count) };
}
/** Ignore horizontal whitespace via diffConfig.override, mapping normalized offsets
 * back to original documents. Newlines remain significant; display is never rewritten. */
export function whitespaceDiff(a: string, b: string): readonly Change[] {
  const left = normalizedWhitespace(a), right = normalizedWhitespace(b);
  return diff(left.value, right.value, { scanLimit: 500, timeout: 1000 }).map(c =>
    new Change(left.positions[c.fromA], left.positions[c.toA], right.positions[c.fromB], right.positions[c.toB]));
}
export const diffConfig = (ignore: boolean) => ({ scanLimit: 500, timeout: 1000, ...(ignore ? { override: whitespaceDiff } : {}) });
export function differenceCount(a: string, b: string, ignore = false) {
  return Chunk.build(Text.of(normalizeEol(a).split("\n")), Text.of(normalizeEol(b).split("\n")), diffConfig(ignore)).length;
}
export function rememberedSource(source: DiffSource | null, tabs: readonly BrowserTab[]): DiffSource | null {
  if (!source || source.tab.id === 0) return source;
  return tabs.some(t => t.id === source.tab.id && !t.exited && t.generation === source.tab.generation &&
    (source.tab.kind !== "ssh" || t.sessionId === source.tab.sessionId)) ? source : null;
}
export function comparisonSources(marked: DiffSource | null, next: DiffSource): [DiffSource, DiffSource] | null {
  return marked ? [marked, next] : null;
}
export const sourceLabel = ({ tab, path }: DiffSource) => `${tab.kind === "ssh" ? tab.target ?? tab.title : tab.kind === "wsl" ? `WSL (${tab.cwd?.host ?? ""})` : t("diff.source.local")}:${path}`;
export function diffError(reason: unknown) {
  const code = errorCode(reason);
  if (code === "BINARY" || code === "TOO_LARGE" || code === "ENCODING" || code === "SESSION_CLOSED") return t(`diff.error.${code}`);
  return t("diff.error.failed", { message: errorText(reason) });
}
export async function loadDiffDocument({ tab, path }: DiffSource): Promise<EditorDocument> {
  if (tab.exited || (tab.kind === "ssh" && tab.sessionId === undefined)) throw new Error("SESSION_CLOSED:");
  const document = await (tab.kind === "ssh" ? invoke<EditorDocument>("editor_open_remote", { id: tab.sessionId, path }) :
    invoke<EditorDocument>("editor_open_local", { path, wslDistro: tab.kind === "wsl" ? tab.cwd?.host ?? null : null }));
  let loaded = false;
  try {
    if (document.size > 5 * 1024 * 1024) throw "TOO_LARGE:";
    const result = { ...document, text: normalizeEol(document.text) };
    loaded = true;
    return result;
  } finally {
    try { await invoke("editor_close", { docId: document.docId }); }
    catch (reason) { if (loaded) throw reason; }
  }
}
export async function loadDiffPair(sources: [DiffSource, DiffSource]): Promise<DiffPair> {
  const documents: [EditorDocument, EditorDocument] = [await loadDiffDocument(sources[0]), await loadDiffDocument(sources[1])];
  return { sources, documents };
}
