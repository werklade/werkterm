import { describe, expect, it } from "vitest";
import { applyPasteChoice, availableScopes, describeRemembered, effectiveScope, emptyPasteRemember, hasPasteControls, hasRemembered, maxRememberedSessions, normalizePasteRemember, pruneRemembered, rememberChoice, rememberedForSession, resetRemembered, resetRememberedSession, resolveRemembered, shouldConfirmPaste, singleLinePaste, stripLastNewline, type PasteChoice, type PasteRemember } from "./paste";
describe("paste", () => {
  it("confirms according to policy and size", () => {
    expect(shouldConfirmPaste("abc", "multiline")).toBe(false);
    expect(shouldConfirmPaste("a\nb", "multiline")).toBe(true);
    expect(shouldConfirmPaste("abc", "always")).toBe(true);
    expect(shouldConfirmPaste("a\nb", "never")).toBe(false);
    expect(shouldConfirmPaste("a".repeat(1024), "multiline")).toBe(false);
    expect(shouldConfirmPaste("a".repeat(1025), "multiline")).toBe(true);
    expect(shouldConfirmPaste("a".repeat(1025), "never")).toBe(false);
  });
  it("always warns about controls", () => {
    for (const c of ["\x1b", "\0", "\b", "\x7f"]) { expect(hasPasteControls(c)).toBe(true); expect(shouldConfirmPaste(c, "never")).toBe(true); }
    expect(hasPasteControls("ü\t\r\n")).toBe(false);
  });
  it("transforms line endings without losing other text", () => {
    expect(singleLinePaste("a\r\nb\rc\n")).toBe("a b c ");
    expect(stripLastNewline("a\r\n\r\n")).toBe("a\r\n");
    expect(stripLastNewline("a")).toBe("a");
  });
});
const paste: PasteChoice = { action: "paste", trim: true };
const single: PasteChoice = { action: "single-line", trim: false };
describe("remembered paste choice", () => {
  const remember: PasteRemember = { global: paste, sessions: { s1: single } };
  it("resolves tab, then profile, then global", () => {
    const tab: PasteChoice = { action: "paste", trim: false };
    expect(resolveRemembered({ text: "a\nb", multiExec: false, tabChoice: tab, sessionId: "s1", remember })).toBe(tab);
    expect(resolveRemembered({ text: "a\nb", multiExec: false, sessionId: "s1", remember })).toBe(single);
    expect(resolveRemembered({ text: "a\nb", multiExec: false, sessionId: "other", remember })).toBe(paste);
    expect(resolveRemembered({ text: "a\nb", multiExec: false, sessionId: null, remember: emptyPasteRemember() })).toBeNull();
    expect(resolveRemembered({ text: "a\nb", multiExec: false, sessionId: "constructor", remember: emptyPasteRemember() })).toBeNull();
  });
  it("always asks for control characters", () => {
    expect(resolveRemembered({ text: "a\x1b[31m", multiExec: false, tabChoice: paste, sessionId: "s1", remember })).toBeNull();
    expect(resolveRemembered({ text: "a\x1b", multiExec: true, remember })).toBeNull();
  });
  it("uses only the global choice with MultiExec", () => {
    expect(resolveRemembered({ text: "a\nb", multiExec: true, tabChoice: single, sessionId: "s1", remember })).toBe(paste);
    expect(resolveRemembered({ text: "a\nb", multiExec: true, sessionId: "s1", remember: { global: null, sessions: { s1: single } } })).toBeNull();
  });
  it("limits selectable scopes", () => {
    expect(availableScopes({ controls: false, multiExec: false, hasProfile: true })).toEqual({ none: true, tab: true, profile: true, global: true });
    expect(availableScopes({ controls: false, multiExec: false, hasProfile: false }).profile).toBe(false);
    expect(availableScopes({ controls: false, multiExec: true, hasProfile: true })).toEqual({ none: true, tab: false, profile: false, global: true });
    expect(availableScopes({ controls: true, multiExec: false, hasProfile: true })).toEqual({ none: true, tab: false, profile: false, global: false });
    expect(effectiveScope("global", availableScopes({ controls: true, multiExec: false, hasProfile: true }))).toBe("none");
  });
  it("applies a choice including the trailing newline flag", () => {
    expect(applyPasteChoice("a\nb\n", paste)).toBe("a\nb");
    expect(applyPasteChoice("a\nb\n", single)).toBe("a b ");
    expect(applyPasteChoice("a\nb\n", { action: "single-line", trim: true })).toBe("a b");
  });
  it("remembers per profile and globally without mutating the input", () => {
    const start = emptyPasteRemember();
    const profile = rememberChoice(start, "profile", "s2", single);
    expect(profile.sessions).toEqual({ s2: single });
    expect(start.sessions).toEqual({});
    expect(rememberChoice(profile, "global", null, paste).global).toEqual(paste);
    expect(rememberChoice(start, "profile", null, paste)).toBe(start);
    expect(rememberChoice(start, "tab", "s2", paste)).toBe(start);
    expect(rememberChoice(start, "none", "s2", paste)).toBe(start);
  });
  it("caps the number of remembered profiles", () => {
    let state = emptyPasteRemember();
    for (let i = 0; i < maxRememberedSessions + 5; i++) state = rememberChoice(state, "profile", `id${i}`, paste);
    expect(Object.keys(state.sessions)).toHaveLength(maxRememberedSessions);
    expect(rememberChoice(state, "profile", "id0", single).sessions.id0).toEqual(single);
  });
  it("resets everything or a single profile", () => {
    expect(resetRemembered()).toEqual({ global: null, sessions: {} });
    expect(resetRememberedSession(remember, "s1")).toEqual({ global: paste, sessions: {} });
    expect(resetRememberedSession(remember, "x")).toBe(remember);
  });
  it("resets one profile and keeps the other profiles and the global choice", () => {
    const two = rememberChoice(remember, "profile", "s2", single);
    expect(resetRememberedSession(two, "s1")).toEqual({ global: paste, sessions: { s2: single } });
    expect(two.sessions.s1).toBeDefined();
  });
  it("reads the choice of one profile from own keys only", () => {
    expect(rememberedForSession(remember, "s1")).toEqual(remember.sessions.s1);
    expect(rememberedForSession(remember, "x")).toBeNull();
    expect(rememberedForSession(remember, "toString")).toBeNull();
    expect(rememberedForSession(remember, undefined)).toBeNull();
  });
  it("prunes deleted sessions", () => {
    expect(pruneRemembered(remember, ["s1", "s9"])).toBe(remember);
    expect(pruneRemembered(remember, ["s9"])).toEqual({ global: paste, sessions: {} });
  });
  it("prunes everything when no session exists", () => {
    expect(pruneRemembered(remember, [])).toEqual({ global: paste, sessions: {} });
    expect(pruneRemembered(emptyPasteRemember(), [])).toEqual(emptyPasteRemember());
  });
  it("treats C1 controls as controls but keeps tab and newlines", () => {
    expect(hasPasteControls("a\x9bb")).toBe(true);
    expect(hasPasteControls("\x80")).toBe(true);
    expect(shouldConfirmPaste("a\x9b31m", "never")).toBe(true);
    expect(hasPasteControls("a\tb\r\nc\n")).toBe(false);
    expect(resolveRemembered({ text: "a\x9b", multiExec: false, remember })).toBeNull();
  });
  it("counts tabs in the description", () => {
    expect(describeRemembered(emptyPasteRemember(), 1)).toBe("Gemerkt: 1 Tab");
    expect(describeRemembered(remember, 2)).toBe("Gemerkt: dauerhaft, 1 Sitzung, 2 Tabs");
    expect(hasRemembered(emptyPasteRemember(), 1)).toBe(true);
    expect(hasRemembered(emptyPasteRemember(), 0)).toBe(false);
  });
  it("describes the state", () => {
    expect(describeRemembered(emptyPasteRemember())).toBe("Nichts gemerkt");
    expect(hasRemembered(emptyPasteRemember())).toBe(false);
    expect(describeRemembered(remember)).toBe("Gemerkt: dauerhaft, 1 Sitzung");
    expect(describeRemembered({ global: null, sessions: { a: paste, b: paste, c: paste } })).toBe("Gemerkt: 3 Sitzungen");
    expect(hasRemembered(remember)).toBe(true);
  });
  it("normalizes broken data strictly", () => {
    for (const input of [null, undefined, 5, "x", [], { global: "paste", sessions: 3 }]) expect(normalizePasteRemember(input)).toEqual(emptyPasteRemember());
    const result = normalizePasteRemember({
      global: { action: "paste", trim: false },
      sessions: { ok: { action: "single-line", trim: true }, badAction: { action: "rm", trim: true }, badTrim: { action: "paste", trim: "yes" }, nul: null, list: [], "": paste, long: undefined },
    });
    expect(result).toEqual({ global: { action: "paste", trim: false }, sessions: { ok: { action: "single-line", trim: true } } });
    expect(normalizePasteRemember({ global: { action: "x", trim: true } }).global).toBeNull();
    expect(normalizePasteRemember(JSON.parse('{"sessions":{"__proto__":{"action":"paste","trim":true}}}')).sessions).toEqual({});
    expect(normalizePasteRemember({ sessions: { ["x".repeat(129)]: paste } }).sessions).toEqual({});
    const many = Object.fromEntries(Array.from({ length: maxRememberedSessions + 50 }, (_, i) => [`s${i}`, paste]));
    expect(Object.keys(normalizePasteRemember({ sessions: many }).sessions)).toHaveLength(maxRememberedSessions);
  });
});
