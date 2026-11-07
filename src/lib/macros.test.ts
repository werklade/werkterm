import { describe, expect, it, vi } from "vitest";
import { escapeText, unescapeText, recordInput, parseShortcut, shortcutFromEvent, shortcutConflict, macroTargets, playbackPlan, runPlayback, pause, type Macro, type Recording } from "./macros";

const base: Recording = { tabId: 1, steps: [], last: null, pauses: false, count: 0 };
describe("macro recording", () => {
  it("coalesces characters and confirmed pasted data without recording pauses by default", () => {
    const a = recordInput(base, "a", 0);
    const b = recordInput(a, "bc\r", 2000);
    expect(b.steps).toEqual([{ type: "text", text: "abc\r" }]);
    expect(b.count).toBe(4);
    expect(a.steps).toEqual([{ type: "text", text: "a" }]);
    expect(recordInput(b, "", 4000)).toBe(b);
  });
  it("records only pauses above one second and splits long pauses at the backend limit", () => {
    const a = recordInput({ ...base, pauses: true }, "a", 0);
    const b = recordInput(a, "b", 1000);
    const c = recordInput(b, "c", 62001);
    expect(c.steps).toEqual([{ type: "text", text: "ab" }, { type: "wait", ms: 60000 }, { type: "wait", ms: 1001 }, { type: "text", text: "c" }]);
  });
});
describe("macro escape syntax", () => {
  it("roundtrips every ASCII and C1 control character, backslashes, Unicode and literal escapes", () => {
    const text = Array.from({ length: 160 }, (_, i) => String.fromCharCode(i)).join("") + "ä😀\\n\\e\\x03";
    expect(unescapeText(escapeText(text))).toBe(text);
    expect(escapeText("\r\t\x1b\x03")).toBe("\\n\\t\\e\\x03");
    expect(unescapeText("\\n\\t\\e\\x03")).toBe("\r\t\x1b\x03");
  });
  it("rejects invalid or incomplete escapes", () => {
    for (const text of ["\\", "\\x", "\\x0", "\\xgg", "\\q"]) expect(() => unescapeText(text)).toThrow();
  });
});
describe("macro shortcuts", () => {
  it("normalizes the two allowed families and rejects unrelated combinations", () => {
    expect(parseShortcut("Strg+Alt+a")).toBe("Ctrl+Alt+A");
    expect(parseShortcut("ctrl+shift+f12")).toBe("Ctrl+Shift+F12");
    for (const key of ["Alt+A", "Ctrl+Shift+A", "Ctrl+Alt+F1", "Ctrl+Shift+F13", "Ctrl+Shift+F01"]) expect(parseShortcut(key)).toBeNull();
    expect(shortcutFromEvent({ key: "å", code: "KeyA", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })).toBe("Ctrl+Alt+A");
    expect(shortcutFromEvent({ key: "1", code: "Digit1", ctrlKey: true, altKey: true, shiftKey: false, metaKey: true })).toBeNull();
  });
  it("detects app and macro conflicts, allowing the current macro's own key", () => {
    const item: Macro = { id: "a", name: "Test", steps: [], shortcut: "Ctrl+Alt+1", created: 0, updated: 0 };
    expect(shortcutConflict("Ctrl+Shift+T", [], "a")).toContain("App");
    expect(shortcutConflict("Ctrl+Alt+1", [item], "b")).toContain("vergeben");
    expect(shortcutConflict("Ctrl+Alt+1", [item], "a")).toBeNull();
    expect(shortcutConflict("", [item], "b")).toBeNull();
  });
});
describe("macro playback", () => {
  it("resolves all prompts before any plan is returned", async () => {
    const ask = vi.fn().mockResolvedValueOnce("user").mockResolvedValueOnce("secret");
    const steps = [{ type: "text" as const, text: "login " }, { type: "prompt" as const, label: "Name", secret: false }, { type: "wait" as const, ms: 123 }, { type: "prompt" as const, label: "Password", secret: true }];
    expect(await playbackPlan(steps, ask, new AbortController().signal)).toEqual([{ type: "text", text: "login " }, { type: "text", text: "user" }, { type: "wait", ms: 123 }, { type: "text", text: "secret" }]);
    expect(steps[3]).not.toHaveProperty("text");
    expect(ask).toHaveBeenCalledTimes(2);
  });
  it("returns no sendable plan when a prompt or controller cancels", async () => {
    const steps = [{ type: "text" as const, text: "do not send" }, { type: "prompt" as const, label: "Password", secret: true }];
    expect(await playbackPlan(steps, async () => null, new AbortController().signal)).toBeNull();
    const controller = new AbortController();
    expect(await playbackPlan(steps, async () => { controller.abort(); return "secret"; }, controller.signal)).toBeNull();
    const ask = vi.fn();
    expect(await playbackPlan(steps, ask, controller.signal)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
  it("interrupts waits immediately on cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = pause(60000, controller.signal);
    controller.abort(); await waiting;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  it("sends nothing after prompt cancellation, preflight cancellation or a closed target", async () => {
    const send = vi.fn();
    const controller = new AbortController();
    expect(await runPlayback(null, controller.signal, () => true, send)).toBe(false);
    expect(await runPlayback([{ type: "text", text: "secret" }], controller.signal, () => false, send)).toBe(false);
    controller.abort();
    expect(await runPlayback([{ type: "text", text: "secret" }], controller.signal, () => true, send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it("waits for the requested time and stops before sending when a target closes", async () => {
    vi.useFakeTimers();
    try {
      let valid = true;
      const send = vi.fn();
      const result = runPlayback([{ type: "text", text: "first" }, { type: "wait", ms: 2000 }, { type: "text", text: "second" }], new AbortController().signal, () => valid, send);
      expect(send).toHaveBeenCalledExactlyOnceWith("first");
      await vi.advanceTimersByTimeAsync(1000);
      expect(send).toHaveBeenCalledTimes(1);
      valid = false;
      await vi.runAllTimersAsync();
      expect(await result).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
describe("macro target selection", () => {
  const recipients = [{ id: 1, checked: true, exited: false }, { id: 2, checked: true, exited: false }, { id: 3, checked: false, exited: false }, { id: 4, checked: true, exited: true }];
  it("uses the active terminal outside MultiExec and the exact keyboard distribution inside it", () => {
    expect(macroTargets(1, recipients, false)).toEqual([1]);
    expect(macroTargets(1, recipients, true)).toEqual([1, 2]);
    expect(macroTargets(3, recipients, true)).toEqual([3]);
    expect(macroTargets(4, recipients, true)).toEqual([]);
    expect(macroTargets(null, recipients, false)).toEqual([]);
    expect(macroTargets(0, recipients, true)).toEqual([]);
  });
});
