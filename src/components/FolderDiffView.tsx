import { useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../lib/backendError";
import { Channel, invoke } from "@tauri-apps/api/core";
import { currentLocale, t as translate, tp, useT, type TextKey } from "../i18n";
import { backendSource, categories, categoryLabel, mergeFolders, selectRows, swapPair, type FolderPair, type FolderResult, type FolderRow, type SortColumn } from "../lib/folderDiff";
import { sourceLabel, type DiffSource } from "../lib/diff";
import { childPath } from "../lib/paths";
import { formatSize } from "../lib/formatSize";
interface Progress { bytes: number; files: number; total: number }
const columns: [SortColumn, TextKey][] = [["name", "folderDiff.col.name"], ["folder", "folderDiff.col.folder"], ["result", "folderDiff.col.result"], ["leftDate", "folderDiff.col.leftDate"], ["leftSize", "folderDiff.col.leftSize"], ["rightDate", "folderDiff.col.rightDate"], ["rightSize", "folderDiff.col.rightSize"]];
const date = (time?: number | null) => time == null ? "—" : new Date(time * 1000).toLocaleString(currentLocale());
const kindLabel = (kind?: string) => kind === "file" ? translate("folderDiff.kind.file") : kind === "dir" ? translate("folderDiff.kind.dir") : kind ?? "";
export function FolderDiffView({ initial, onOpen, onTitle }: { initial: FolderPair; onOpen(sources: [DiffSource, DiffSource]): Promise<void>; onTitle?(sources: [DiffSource, DiffSource]): void }) {
  const t = useT();
  const [pair, setPair] = useState(initial), [reload, setReload] = useState(0), [data, setData] = useState<FolderResult | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [progress, setProgress] = useState<Progress>({ bytes: 0, files: 0, total: 0 });
  const [sort, setSort] = useState<SortColumn>("name"), [descending, setDescending] = useState(false), [differences, setDifferences] = useState(false), [search, setSearch] = useState("");
  const [scroll, setScroll] = useState(0), [height, setHeight] = useState(400);
  const viewport = useRef<HTMLDivElement>(null), cancelJob = useRef<() => void>(() => {});
  const cancel = () => cancelJob.current();
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight)); observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let alive = true;
    const token = crypto.randomUUID();
    let registered = false, cancelled = false;
    const abort = () => { cancelled = true; if (registered) void invoke("folder_diff_cancel", { token }).catch(() => undefined); };
    cancelJob.current = abort;
    setBusy(true); setError(""); setData(null); setProgress({ bytes: 0, files: 0, total: 0 });
    const channel = new Channel<Progress>(); channel.onmessage = p => { registered = true; if (cancelled) abort(); if (alive) setProgress(p); };
    void invoke<FolderResult>("folder_diff_compare", { left: backendSource(pair.sources[0]), right: backendSource(pair.sources[1]), ...pair.options, token, onProgress: channel }).then(result => { if (alive) setData(result); }).catch(reason => { if (alive) setError(errorText(reason)); }).finally(() => { if (alive) { setBusy(false); cancelJob.current = () => {}; } });
    return () => { alive = false; abort(); };
  }, [pair, reload]);
  const rows = useMemo(() => data ? mergeFolders(data) : [], [data]);
  const selected = useMemo(() => selectRows(rows, sort, descending, differences, search), [rows, sort, descending, differences, search]);
  const counts = useMemo(() => { const result = Object.fromEntries(categories.map(c => [c, 0])); for (const row of rows) result[row.result]++; return result; }, [rows]);
  const start = Math.max(0, Math.min(Math.floor(scroll / 32) - 5, selected.length - 1));
  const visible = selected.slice(start, start + Math.ceil(height / 32) + 12);
  const open = (row: FolderRow) => { if (row.left?.kind !== "file" || row.right?.kind !== "file") return; void onOpen(pair.sources.map(source => ({ ...source, path: childPath(source.path, row.path) })) as [DiffSource, DiffSource]).catch(reason => setError(errorText(reason))); };
  return <section className="folder-diff" aria-label={t("folderDiff.title")}>
    <div className="folder-diff-toolbar"><button disabled={busy} onClick={() => setReload(n => n + 1)}>{t("diff.reload")}</button><button disabled={busy} onClick={() => { const swapped = swapPair(pair); setPair(swapped); onTitle?.(swapped.sources); }}>{t("diff.swap")}</button>
      <label><input type="checkbox" disabled={busy} checked={pair.options.recursive} onChange={e => setPair({ ...pair, options: { ...pair.options, recursive: e.target.checked } })} />{t("diff.recursive")}</label>
      <label><input type="checkbox" disabled={busy} checked={pair.options.contents} onChange={e => setPair({ ...pair, options: { ...pair.options, contents: e.target.checked } })} />{t("diff.contents")}</label>
      <label><input type="checkbox" checked={differences} onChange={e => setDifferences(e.target.checked)} />{t("folderDiff.onlyDifferences")}</label><input aria-label={t("folderDiff.search")} placeholder={t("folderDiff.searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} />
    </div>
    <div className="folder-diff-paths">{sourceLabel(pair.sources[0])} ↔ {sourceLabel(pair.sources[1])}</div>
    {busy && <div role="status"><progress max={progress.total || undefined} value={progress.total ? progress.bytes : undefined} /> {formatSize(progress.bytes)} / {formatSize(progress.total)} · {tp("folderDiff.files", progress.files)} <button onClick={cancel}>{t("common.cancel")}</button></div>}
    {error && <p role="alert">{error}</p>}
    {data && <div role="status">{categories.map(c => `${categoryLabel(c)}: ${counts[c]}`).join(" · ")}{(data.left.truncated || data.right.truncated) && ` · ${t("folderDiff.truncated", { max: (50000).toLocaleString(currentLocale()) })}`}{data.limited && ` · ${t("folderDiff.limited")}`}</div>}
    <div className="folder-diff-table" role="table" aria-rowcount={selected.length + 1}>
      <div role="row" className="folder-diff-row folder-diff-head">{columns.map(([key, titleKey]) =><div role="columnheader" aria-sort={sort === key ? descending ? "descending" : "ascending" : "none"} key={key}><button onClick={() => { if (sort === key) setDescending(!descending); else { setSort(key); setDescending(false); } }}>{t(titleKey)}{sort === key ? descending ? " ▼" : " ▲" : ""}</button></div>)}</div>
      <div className="folder-diff-scroll" ref={viewport} onScroll={e => setScroll(e.currentTarget.scrollTop)}>
        <div style={{ height: selected.length * 32, position: "relative" }}>{visible.map((row, index) => <div key={row.path} role="row" aria-rowindex={start + index + 2} tabIndex={0} className={`folder-diff-row result-${categories.indexOf(row.result)}`} style={{ position: "absolute", top: (start + index) * 32, width: "100%" }} onDoubleClick={() => open(row)} onKeyDown={e => { if (e.key === "Enter") open(row); if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const next = start + index + (e.key === "ArrowDown" ? 1 : -1); if (next >= 0 && next < selected.length) { viewport.current?.scrollTo({ top: next * 32 }); requestAnimationFrame(() => viewport.current?.querySelector<HTMLElement>(`[aria-rowindex="${next + 2}"]`)?.focus()); } } }}>
          <span role="cell" title={`${row.path} (${kindLabel(row.left?.kind ?? row.right?.kind)})`}>{row.name}</span><span role="cell" title={row.folder}>{row.folder}</span><span role="cell" title={row.timeHint && data?.content[row.path] !== undefined ? t("folderDiff.timeHint") : undefined}>{categoryLabel(row.result)}{row.timeHint && data?.content[row.path] !== undefined ? " ⓘ" : ""}</span><span role="cell">{date(row.left?.mtime)}</span><span role="cell">{row.left ? formatSize(row.left.size) : "—"}</span><span role="cell">{date(row.right?.mtime)}</span><span role="cell">{row.right ? formatSize(row.right.size) : "—"}</span>
        </div>)}</div>
      </div>
    </div>
  </section>;
}
