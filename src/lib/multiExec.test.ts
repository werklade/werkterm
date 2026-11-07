import { expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { encodePaste, inputProvenance, gridColumns, inputTargets, pasteLines, requiresPasteConfirmation } from "./multiExec";
it("selects live checked targets and always the focused terminal", () => {
  const terminals = [{id:1,checked:true,exited:false},{id:2,checked:true,exited:false},{id:3,checked:true,exited:true}];
  expect(inputTargets(1,terminals)).toEqual([1,2]);
  expect(inputTargets(1,[{...terminals[0],checked:false},terminals[1]])).toEqual([1]);
  expect(inputTargets(3,terminals)).toEqual([]);
});

it("encodes the same raw clipboard independently for each target", () => {
  const raw = "first\r\nsecond\nthird\rfourth";
  expect(encodePaste(raw, false)).toBe("first\rsecond\rthird\rfourth");
  expect(encodePaste(raw, true)).toBe("\x1b[200~first\rsecond\rthird\rfourth\x1b[201~");
});

it("keeps real xterm device and cursor replies local", async () => {
  const terminal = new Terminal();
  const provenance = inputProvenance(terminal);
  const replies: { data: string; user: boolean }[] = [];
  const listener = terminal.onData(data => replies.push({ data, user: provenance.isUserInput() }));
  try {
    terminal.input("typed", true);
    await new Promise<void>(resolve => terminal.write("\x1b[c\x1b[6n\x1b]10;?\x07\x1b[?1004h", resolve));
    expect(replies[0]).toEqual({ data: "typed", user: true });
    expect(replies.slice(1).length).toBeGreaterThanOrEqual(2);
    expect(replies.slice(1).every(reply => !reply.user)).toBe(true);
    terminal.input("IME/paste", true);
    expect(replies[replies.length - 1]).toEqual({ data: "IME/paste", user: true });
  } finally { listener.dispose(); provenance.dispose(); terminal.dispose(); }
});

it("distinguishes user input from all protocol replies and restores provenance", async () => {
  const distributed: string[] = [], local: string[] = [];
  const coreService = { triggerDataEvent(data: string, _user = false) {
    (provenance.isUserInput() ? distributed : local).push(data);
  } };
  const original = coreService.triggerDataEvent;
  const provenance = inputProvenance({ _core: { coreService } });
  coreService.triggerDataEvent("keyboard", true);
  await Promise.resolve();
  coreService.triggerDataEvent("IME", true);
  for (const reply of ["\x1b[?1;2c", "\x1b[1;1R", "\x1b]10;rgb:ff/ff/ff\x07", "\x1b[I", "\x1b[O"])
    coreService.triggerDataEvent(reply);
  expect(distributed).toEqual(["keyboard", "IME"]);
  expect(local).toHaveLength(5);
  expect(provenance.isUserInput()).toBe(false);
  provenance.dispose();
  expect(coreService.triggerDataEvent).toBe(original);
  expect(inputProvenance({}).isUserInput()).toBe(false);
});
it("calculates square grid columns and multiline paste", () => {
  expect([0,1,2,4,5,9].map(gridColumns)).toEqual([1,1,2,2,3,3]);
  expect(pasteLines("hello")).toBe(0);
  expect(pasteLines("a\r\nb")).toBe(2);
  expect(pasteLines("\x1b[200~a\nb\x1b[201~")).toBe(2);
});

it("confirms multiline pastes but never ordinary Enter", () => {
  expect(requiresPasteConfirmation(true, false, "\r")).toBe(false);
  expect(requiresPasteConfirmation(true, true, "\r")).toBe(true);
  expect(requiresPasteConfirmation(false, true, "a\nb")).toBe(false);
  expect(requiresPasteConfirmation(true, true, "hello")).toBe(false);
  expect(requiresPasteConfirmation(true, true, "a\nb")).toBe(true);
});
