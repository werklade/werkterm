import { inputTargets, type Recipient } from "./multiExec";
import { shortcutAction, type ShortcutEvent } from "./menu";

export type MacroStep = { type: "text"; text: string } | { type: "wait"; ms: number } | { type: "prompt"; label: string; secret: boolean };
export interface Macro { id: string; name: string; steps: MacroStep[]; shortcut: string | null; created: number; updated: number }
export const newMacro = (steps: MacroStep[] = []): Macro => ({ id: crypto.randomUUID(), name: `Makro ${new Date().toLocaleString()}`, steps, shortcut: null, created: Date.now(), updated: Date.now() });

/** Reversible display syntax. Enter is CR for terminal input; LF retains its own escape. */
export function escapeText(text: string): string {
  return Array.from(text, char => {
    if (char === "\\") return "\\\\";
    if (char === "\r") return "\\n";
    if (char === "\n") return "\\x0a";
    if (char === "\t") return "\\t";
    if (char === "\x1b") return "\\e";
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 || (code >= 128 && code <= 159) ? `\\x${code.toString(16).padStart(2, "0")}` : char;
  }).join("");
}
export function unescapeText(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\\") { result += text[i]; continue; }
    const code = text[++i];
    if (code === "n") result += "\r";
    else if (code === "t") result += "\t";
    else if (code === "e") result += "\x1b";
    else if (code === "\\") result += "\\";
    else if (code === "x" && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) { result += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; }
    else throw new Error("Ungültige Escape-Sequenz. Erlaubt: \\n, \\t, \\e, \\xNN, \\\\");
  }
  return result;
}

export interface Recording { tabId: number; steps: MacroStep[]; last: number | null; pauses: boolean; count: number }
export function recordInput(recording: Recording, data: string, now: number): Recording {
  if (!data) return recording;
  const steps = recording.steps.map(step => ({ ...step }));
  if (recording.pauses && recording.last !== null && now - recording.last > 1000) {
    let remaining = now - recording.last;
    while (remaining > 0) { const ms = Math.min(60000, remaining); steps.push({ type: "wait", ms }); remaining -= ms; }
  }
  const previous = steps[steps.length - 1];
  if (previous?.type === "text") previous.text += data;
  else steps.push({ type: "text", text: data });
  return { ...recording, steps, last: now, count: recording.count + Array.from(data).length };
}

export function parseShortcut(value: string): string | null {
  const normalized = value.replace(/\s/g, "").replace(/Strg/gi, "Ctrl").replace(/Umschalt/gi, "Shift");
  const match = /^(ctrl\+alt\+([0-9a-z])|ctrl\+shift\+(F(?:[1-9]|1[0-2])))$/i.exec(normalized);
  if (!match) return null;
  return match[2] ? `Ctrl+Alt+${match[2].toUpperCase()}` : `Ctrl+Shift+${match[3].toUpperCase()}`;
}
export function shortcutFromEvent(event: ShortcutEvent): string | null {
  if (event.metaKey) return null;
  const key = /^(Digit[0-9]|Key[A-Z])$/.test(event.code) ? event.code.replace(/^(Digit|Key)/, "") : event.key;
  return parseShortcut(`${event.ctrlKey ? "Ctrl+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}${key}`);
}
export function shortcutConflict(value: string, items: Macro[], id: string): string | null {
  if (!value) return null;
  const parts = value.replace(/Strg/gi, "Ctrl").replace(/Umschalt/gi, "Shift").split("+");
  const key = parts[parts.length - 1] ?? "";
  if (shortcutAction({ key, code: key === "0" ? "Digit0" : key, ctrlKey: parts.includes("Ctrl"), shiftKey: parts.includes("Shift"), altKey: parts.includes("Alt"), metaKey: false }, false)) return "Konflikt mit einem App-Tastenkürzel";
  const shortcut = parseShortcut(value);
  if (!shortcut) return "Erlaubt: Strg+Alt+0–9/A–Z oder Strg+Umschalt+F1–F12";
  return items.some(item => item.id !== id && item.shortcut === shortcut) ? "Tastenkürzel bereits vergeben" : null;
}

export const macroTargets = (focused: number | null, recipients: Recipient[], multiExec: boolean): number[] => focused === null ? [] : multiExec ? inputTargets(focused, recipients) : recipients.filter(t => t.id === focused && !t.exited).map(t => t.id);
export type PlayStep = Exclude<MacroStep, { type: "prompt" }>;
export function clearPlayback(plan: PlayStep[]) {
  for (const step of plan) if (step.type === "text") step.text = "";
  plan.length = 0;
}
/** Resolve every prompt before returning a plan; cancellation yields no sendable steps. */
export async function playbackPlan(steps: MacroStep[], ask: (step: Extract<MacroStep, { type: "prompt" }>) => Promise<string | null>, signal: AbortSignal): Promise<PlayStep[] | null> {
  const plan: PlayStep[] = [];
  let completed = false;
  const discard = () => clearPlayback(plan);
  signal.addEventListener("abort", discard, { once: true });
  try {
    for (const step of steps) {
      if (signal.aborted) return null;
      if (step.type === "prompt") {
        let value = await ask(step);
        if (value === null || signal.aborted) { value = null; return null; }
        plan.push({ type: "text", text: value });
        value = null;
      } else plan.push({ ...step });
    }
    completed = !signal.aborted;
    return completed ? plan : null;
  } finally {
    signal.removeEventListener("abort", discard);
    if (!completed) discard();
  }
}
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done(); else signal.addEventListener("abort", done, { once: true });
  });
}

/** The caller owns a fixed target snapshot. Revalidate before every send after a wait. */
export async function runPlayback(plan: PlayStep[] | null, signal: AbortSignal, valid: () => boolean, send: (text: string) => void): Promise<boolean> {
  if (!plan) return false;
  const discard = () => clearPlayback(plan);
  signal.addEventListener("abort", discard, { once: true });
  try {
    for (const step of plan) {
      if (signal.aborted || !valid()) return false;
      if (step.type === "wait") await pause(step.ms, signal);
      else {
        try { send(step.text); } finally { step.text = ""; }
        await pause(0, signal);
      }
    }
    return !signal.aborted && valid();
  } finally {
    signal.removeEventListener("abort", discard);
    discard();
  }
}
