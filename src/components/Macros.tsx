import { useEffect, useRef, useState } from "react";
import { errorText } from "../lib/backendError";
import { invoke } from "@tauri-apps/api/core";
import { useModal } from "./useModal";
import { SecretDialog } from "./SecretDialog";
import { escapeText, unescapeText, newMacro, recordInput, shortcutConflict, shortcutFromEvent, parseShortcut, displayShortcut, allowedShortcuts, macroTargets, playbackPlan, runPlayback, clearPlayback, type Macro, type MacroStep, type Recording } from "../lib/macros";
import { terminalWriters, type Recipient } from "../lib/multiExec";
import { formatShortcut } from "../lib/formatShortcut";
import { tp, useT } from "../i18n";
import "./Macros.css";

type Question = { sequence: number; label: string; secret: boolean; answer(value: string | null): void };
function QuestionDialog({ question }: { question: Question }) {
  const t = useT();
  const modal = useModal();
  const [value, setValue] = useState("");
  return <dialog ref={modal} className="ssh-dialog" aria-label={t("macro.question.title")} onCancel={event => { event.preventDefault(); question.answer(null); }}><form onSubmit={event => { event.preventDefault(); question.answer(value); setValue(""); }}><h2>{t("macro.question.title")}</h2><label>{question.label}<input autoFocus type={question.secret ? "password" : "text"} autoComplete="off" value={value} onChange={event => setValue(event.target.value)} /></label><div className="dialog-actions"><button type="submit">{t("app.next")}</button><button type="button" onClick={() => question.answer(null)}>{t("common.cancel")}</button></div></form></dialog>;
}
function ConfirmDialog({ title, children, accept, onAnswer }: { title: string; children: React.ReactNode; accept: string; onAnswer(value: boolean): void }) {
  const t = useT();
  const modal = useModal();
  return <dialog ref={modal} className="ssh-dialog" aria-label={title} onCancel={event => { event.preventDefault(); onAnswer(false); }}><h2>{title}</h2>{children}<div className="dialog-actions"><button onClick={() => onAnswer(true)}>{accept}</button><button autoFocus onClick={() => onAnswer(false)}>{t("common.cancel")}</button></div></dialog>;
}
const stepTypeKey = { text: "macro.step.text", wait: "macro.step.wait", prompt: "macro.question.title" } as const;
const addKey = { text: "macro.add.text", wait: "macro.add.wait", prompt: "macro.add.prompt" } as const;
function MacroEditor({ item, items, onClose, onSave }: { item: Macro; items: Macro[]; onClose(): void; onSave(item: Macro): Promise<void> }) {
  const t = useT();
  const modal = useModal();
  const [name, setName] = useState(item.name);
  const [shortcut, setShortcut] = useState(item.shortcut ?? "");
  const [steps, setSteps] = useState<MacroStep[]>(() => item.steps.map(step => step.type === "text" ? { ...step, text: escapeText(step.text) } : { ...step }));
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = (index: number, step: MacroStep) => setSteps(current => current.map((old, i) => i === index ? step : old));
  const move = (index: number, delta: number) => { setSteps(current => { const next = [...current]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next; }); setSelected(index + delta); };
  const save = async () => {
    try {
      const conflict = shortcutConflict(shortcut, items, item.id);
      if (conflict) throw new Error(conflict);
      if (!name.trim() || Array.from(name).length > 80) throw new Error(t("macro.error.name"));
      if (steps.length > 500) throw new Error(t("macro.error.steps"));
      const decoded = steps.map(step => step.type === "text" ? { ...step, text: unescapeText(step.text) } : step);
      if (decoded.reduce((total, step) => total + (step.type === "text" ? new TextEncoder().encode(step.text).length : 0), 0) > 65536) throw new Error(t("macro.error.size"));
      if (decoded.some(step => step.type === "wait" && (!Number.isInteger(step.ms) || step.ms < 0 || step.ms > 60000))) throw new Error(t("macro.error.wait"));
      if (decoded.some(step => step.type === "prompt" && (!step.label.trim() || Array.from(step.label).length > 200))) throw new Error(t("macro.error.prompt"));
      setBusy(true);
      await onSave({ ...item, name, shortcut: shortcut ? parseShortcut(shortcut) : null, steps: decoded, updated: Date.now() });
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <dialog ref={modal} className="ssh-dialog macro-editor" aria-label={t("macro.editor.title")} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><h2>{t("macro.editor.title")}</h2><p>{t("macro.editor.plaintext")}</p><label>{t("macro.editor.name")}<input autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label><label>{t("macro.editor.shortcut")}<input readOnly placeholder={t("macro.editor.shortcutPlaceholder")} value={displayShortcut(shortcut)} onKeyDown={event => {
    if (event.key === "Tab" || event.key === "Escape") return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === "Backspace" || event.key === "Delete") { setShortcut(""); setError(""); return; }
    if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
    const value = shortcutFromEvent(event.nativeEvent);
    if (value) { setShortcut(value); setError(shortcutConflict(value, items, item.id) ?? ""); }
    else setError(allowedShortcuts());
  }} /></label><p className="macro-hint">{t("macro.editor.escapes", { interrupt: formatShortcut(["ctrl", "C"]) })}</p>
    <div className="macro-steps">{steps.map((step, index) => <section key={index} className={selected === index ? "selected" : ""} onFocus={() => setSelected(index)} onClick={() => setSelected(index)}><div className="macro-step-heading"><strong>{index + 1}. {t(stepTypeKey[step.type])}</strong><button disabled={index === 0} onClick={event => { event.stopPropagation(); move(index, -1); }}>{t("macro.step.up")}</button><button disabled={index === steps.length - 1} onClick={event => { event.stopPropagation(); move(index, 1); }}>{t("macro.step.down")}</button><button onClick={() => { setSteps(current => current.filter((_, i) => i !== index)); setSelected(Math.max(0, index - 1)); }}>{t("common.delete")}</button></div>
      {step.type === "text" ? <><textarea aria-label={t("macro.step.textLabel", { n: index + 1 })} rows={3} value={step.text} onChange={event => update(index, { ...step, text: event.target.value })} /><button onClick={() => update(index, { type: "prompt", label: t("macro.defaultPromptLabel"), secret: true })}>{t("macro.step.toPrompt")}</button></> : step.type === "wait" ? <label>{t("macro.step.ms")}<input type="number" min={0} max={60000} value={step.ms} onChange={event => update(index, { ...step, ms: Number(event.target.value) })} /></label> : <><label>{t("macro.step.label")}<input maxLength={200} value={step.label} onChange={event => update(index, { ...step, label: event.target.value })} /></label><label><input type="checkbox" checked={step.secret} onChange={event => update(index, { ...step, secret: event.target.checked })} />{t("macro.step.secret")}</label></>}
    </section>)}</div><div className="macro-add">{(["text", "wait", "prompt"] as const).map(type => <button key={type} disabled={steps.length >= 500} onClick={() => { setSelected(steps.length); setSteps(current => [...current, type === "text" ? { type, text: "" } : type === "wait" ? { type, ms: 1000 } : { type, label: t("macro.defaultPromptLabel"), secret: true }]); }}>{t(addKey[type])}</button>)}</div>{error && <p role="alert">{error}</p>}<div className="dialog-actions"><button disabled={busy} onClick={() => void save()}>{t("common.save")}</button><button disabled={busy} onClick={onClose}>{t("common.cancel")}</button></div></dialog>;
}

interface Options { activeId: number | null; recipients: Recipient[]; multiExec: boolean; report(message: string): void; showPanel(): void; /** false until the data folder is usable; defaults to true. */ enabled?: boolean }
export function useMacros(options: Options) {
  const t = useT();
  const [items, setItems] = useState<Macro[]>([]);
  const [recording, setRecording] = useState<Recording | null>(null);
  const recordingRef = useRef(recording);
  const [warning, setWarning] = useState(false);
  const [pauses, setPauses] = useState(false);
  const [editor, setEditor] = useState<Macro | null>(null);
  const [deleting, setDeleting] = useState<Macro | null>(null);
  const questionSequence = useRef(0);
  const [question, setQuestion] = useState<Question | null>(null);
  const [playing, setPlaying] = useState(false);
  const playback = useRef<{ controller: AbortController; targets: number[] } | null>(null);
  const latest = useRef(options); latest.current = options;
  const reload = async () => setItems(await invoke<Macro[]>("macros_list"));
  const enabled = options.enabled !== false;
  useEffect(() => { if (enabled) void reload().catch(reason => latest.current.report(errorText(reason))); }, [enabled]);
  const stop = () => { const current = recordingRef.current; if (!current) return; recordingRef.current = null; setRecording(null); setEditor(newMacro(current.steps)); };
  const capture = (id: number, data: string) => {
    const current = recordingRef.current;
    if (!current || current.tabId !== id) return;
    const next = recordInput(current, data, performance.now());
    recordingRef.current = next; setRecording(next);
    if (next.steps.length >= 500 || next.steps.reduce((n, s) => n + (s.type === "text" ? new TextEncoder().encode(s.text).length : 0), 0) >= 65536) { stop(); latest.current.report(t("macro.report.limit")); }
  };
  const cancel = () => { playback.current?.controller.abort(); };
  const play = async (item: Macro) => {
    if (playback.current || recordingRef.current) { latest.current.report(t("macro.report.busy")); return; }
    const { activeId, recipients, multiExec } = latest.current;
    const targets = macroTargets(activeId, recipients, multiExec);
    if (!targets.length) { latest.current.report(t("macro.report.noTerminal")); return; }
    const controller = new AbortController();
    playback.current = { controller, targets }; setPlaying(true);
    let plan: Awaited<ReturnType<typeof playbackPlan>> = null;
    try {
      plan = await playbackPlan(item.steps, step => new Promise(resolve => {
        const answer = (value: string | null) => { controller.signal.removeEventListener("abort", aborted); setQuestion(null); resolve(value); };
        const aborted = () => answer(null);
        if (controller.signal.aborted) { resolve(null); return; }
        controller.signal.addEventListener("abort", aborted, { once: true });
        setQuestion({ sequence: ++questionSequence.current, label: step.label, secret: step.secret, answer });
      }), controller.signal);
      const completed = await runPlayback(plan, controller.signal,
        () => targets.every(id => latest.current.recipients.some(t => t.id === id && !t.exited) && terminalWriters.has(id)),
        text => { for (const id of targets) terminalWriters.get(id)?.(text, false); });
      latest.current.report(completed ? t("macro.report.played") : t("macro.report.cancelled"));
    } catch { latest.current.report(t("macro.report.failed")); }
    finally { if (plan) clearPlayback(plan); playback.current = null; setPlaying(false); setQuestion(null); }
  };
  useEffect(() => {
    if (recordingRef.current && !options.recipients.some(t => t.id === recordingRef.current!.tabId && !t.exited)) stop();
    if (playback.current && playback.current.targets.some(id => !options.recipients.some(t => t.id === id && !t.exited))) cancel();
  });
  useEffect(() => () => { playback.current?.controller.abort(); recordingRef.current = null; }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.getModifierState("AltGraph") || document.querySelector("dialog[open]") || (event.target instanceof Element && event.target.closest(".editor-view, .cm-editor, input:not(.xterm-helper-textarea), textarea:not(.xterm-helper-textarea), [contenteditable=true]"))) return;
      const shortcut = shortcutFromEvent(event);
      const item = shortcut && items.find(macro => macro.shortcut === shortcut);
      if (item) { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) void play(item); }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  });
  const start = () => {
    if (recordingRef.current) { stop(); return; }
    if (playback.current) { options.report(t("macro.report.stopPlayback")); return; }
    if (!macroTargets(options.activeId, options.recipients, false).length) { options.report(t("macro.report.noTerminalRecord")); return; }
    setWarning(true);
  };
  const action = (name: string): boolean => {
    if (name === "macros") { options.showPanel(); return true; }
    if (name === "macro:new") { setEditor(newMacro()); return true; }
    if (name === "macro:record") { start(); return true; }
    if (name.startsWith("macro:play:")) { const item = items.find(m => m.id === name.slice(11)); if (item) void play(item); return true; }
    return false;
  };
  const [context, setContext] = useState<{ item: Macro; x: number; y: number } | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!context) return;
    contextRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => { if (!contextRef.current?.contains(event.target as Node)) setContext(null); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [context]);
  const panel = <div className="macros-panel"><div className="macro-add"><button disabled={playing} onClick={start}>{recording ? t("macro.panel.stop") : t("macro.panel.record")}</button><button onClick={() => setEditor(newMacro())}>{t("menu.macros.new")}</button></div><label><input type="checkbox" checked={pauses} disabled={!!recording} onChange={event => setPauses(event.target.checked)} />{t("macro.panel.pauses")}</label>{recording && <p role="status">{tp("macro.panel.recording", recording.count)}</p>}{playing && <p role="status">{t("macro.panel.playing")} <button onClick={cancel}>{t("common.cancel")}</button></p>}<ul className="macro-list">{items.map(item => <li key={item.id}><button onDoubleClick={() => void play(item)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void play(item); } }} onContextMenu={event => { event.preventDefault(); setContext({ item, x: event.clientX, y: event.clientY }); }}><strong>{item.name}</strong><small>{item.shortcut ? displayShortcut(item.shortcut) : t("macro.panel.noShortcut")} · {tp("macro.panel.steps", item.steps.length)}</small></button></li>)}</ul>{!items.length && <p>{t("sidebar.placeholder.macros")}</p>}</div>;
  const dialogs = <>{warning && <ConfirmDialog title={t("macro.record.title")} accept={t("macro.record.start")} onAnswer={accepted => { setWarning(false); if (accepted) { const id = latest.current.activeId; if (id === null || !macroTargets(id, latest.current.recipients, false).length) { options.report(t("macro.report.terminalGone")); return; } const next: Recording = { tabId: id, steps: [], last: null, pauses, count: 0 }; recordingRef.current = next; setRecording(next); options.showPanel(); requestAnimationFrame(() => document.querySelector<HTMLElement>(`#terminal-${id} .xterm-helper-textarea`)?.focus()); } }}><p>{t("macro.record.warning")}</p></ConfirmDialog>}{editor && <MacroEditor key={editor.id} item={editor} items={items} onClose={() => setEditor(null)} onSave={async item => { await invoke("macro_save", { item }); await reload(); setEditor(null); }} />}{question && (question.secret ? <SecretDialog key={question.sequence} title={t("macro.question.titleLabel", { label: question.label })} prompt={{ type: "secret", requestId: question.sequence, kind: "password", label: question.label }} onAnswer={question.answer} /> : <QuestionDialog key={question.sequence} question={question} />)}{deleting && <ConfirmDialog title={t("macro.delete.title")} accept={t("common.delete")} onAnswer={accepted => { const item = deleting; setDeleting(null); if (accepted) void invoke("macro_delete", { id: item.id }).then(reload).catch(reason => options.report(errorText(reason))); }}><p>{t("macro.delete.text", { name: deleting.name })}</p></ConfirmDialog>}{context && <div ref={contextRef} className="session-context" role="menu" style={{ left: Math.max(0, Math.min(context.x, window.innerWidth - 240)), top: Math.max(0, Math.min(context.y, window.innerHeight - 180)) }} onKeyDown={event => { if (event.key === "Escape") setContext(null); if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const buttons = Array.from(contextRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus(); } }}>{(["macro.context.play", "macro.context.edit", "macro.context.duplicate", "common.delete"] as const).map((label, index) => <button role="menuitem" key={label} onClick={() => { const item = context.item; setContext(null); if (index === 0) void play(item); else if (index === 1) setEditor(item); else if (index === 2) setEditor({ ...newMacro(item.steps.map(step => ({ ...step }))), name: t("macro.copyName", { name: item.name.slice(0, 72) }) }); else setDeleting(item); }}>{t(label)}</button>)}</div>}</>;
  return { items, recordingId: recording?.tabId, recording: !!recording, playing, cancel, capture, action, panel, dialogs, reload };
}
