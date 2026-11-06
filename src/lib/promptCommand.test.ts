import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildPromptCommand, createPromptCommandSender, SSH_PROMPT_COMMAND } from "./promptCommand";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("uses a single-line byte-encoding Bash hook", () => {
  expect(SSH_PROMPT_COMMAND).toContain('local LC_ALL=C p="$PWD"');
  expect(SSH_PROMPT_COMMAND).toContain('i<${#p}');
  expect(SSH_PROMPT_COMMAND).toContain('c="${p:i:1}"');
  expect(SSH_PROMPT_COMMAND).toContain("[-_.~a-zA-Z0-9/]");
  expect(SSH_PROMPT_COMMAND).toContain("printf -v c '%%%02X' \"'$c\"");
  expect(SSH_PROMPT_COMMAND).toContain('__linmoba_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}');
  expect(SSH_PROMPT_COMMAND.endsWith("\r")).toBe(true);
  expect(SSH_PROMPT_COMMAND).not.toContain("\n");
});

it.each([true, false])("waits for 400 ms of quiet and sends once, data first: %s", dataFirst => {
  const write = vi.fn(async (_id: number, _data: string) => undefined);
  const sender = createPromptCommandSender(() => true, write, vi.fn());
  if (dataFirst) sender.receiveData(); else sender.connect(42);
  vi.advanceTimersByTime(200);
  if (dataFirst) sender.connect(42); else sender.receiveData();
  sender.receiveData();
  vi.advanceTimersByTime(399);
  expect(write).not.toHaveBeenCalled();
  sender.receiveData();
  vi.advanceTimersByTime(400);
  expect(write).toHaveBeenCalledExactlyOnceWith(42, buildPromptCommand(80, 0));
  sender.receiveData();
  vi.advanceTimersByTime(6000);
  expect(write).toHaveBeenCalledTimes(1);
});

it("bounds continuous login output to five seconds after connecting", () => {
  const write = vi.fn(async () => undefined);
  const sender = createPromptCommandSender(() => true, write, vi.fn());
  sender.connect(1);
  for (let i = 0; i < 49; i++) { sender.receiveData(); vi.advanceTimersByTime(100); }
  expect(write).not.toHaveBeenCalled();
  sender.receiveData();
  vi.advanceTimersByTime(100);
  expect(write).toHaveBeenCalledExactlyOnceWith(1, buildPromptCommand(80, 0));
});

it("requires first data even when the deadline expires", () => {
  const write = vi.fn(async () => undefined);
  const sender = createPromptCommandSender(() => true, write, vi.fn());
  sender.connect(1);
  vi.advanceTimersByTime(6000);
  expect(write).not.toHaveBeenCalled();
  sender.receiveData();
  expect(write).toHaveBeenCalledTimes(1);
});

it("does not inject after cleanup or while disabled", () => {
  const write = vi.fn(async () => undefined);
  const disposed = createPromptCommandSender(() => true, write, vi.fn());
  disposed.connect(42); disposed.receiveData(); disposed.dispose();
  const disabled = createPromptCommandSender(() => false, write, vi.fn());
  disabled.connect(43); disabled.receiveData();
  vi.advanceTimersByTime(6000);
  expect(write).not.toHaveBeenCalled();
});

it("reports write failures without retrying", async () => {
  const error = new Error("write failed");
  const report = vi.fn();
  const write = vi.fn(async () => { throw error; });
  const sender = createPromptCommandSender(() => true, write, report);
  sender.connect(1); sender.receiveData();
  await vi.advanceTimersByTimeAsync(400);
  expect(report).toHaveBeenCalledWith(error);
  sender.receiveData(); vi.advanceTimersByTime(6000);
  expect(write).toHaveBeenCalledTimes(1);
});

it("clears a single echoed row and terminates with one carriage return", () => {
  const command = buildPromptCommand(4096, 0);
  expect(command).toBe(SSH_PROMPT_COMMAND.slice(0, -1) + String.raw`; printf '\033[1A\r\033[J'` + "\r");
  expect(command).not.toContain("\n");
  expect(command.match(/\r/g)).toHaveLength(1);
});

it("includes the current prompt column and every wrapped command row", () => {
  // Rows are counted for the full echoed line, including the printf suffix itself.
  const echoed = (cols: number, cursorX: number) => buildPromptCommand(cols, cursorX).replace(/\r/g, "");
  const rowsOf = (cols: number, cursorX: number) => Number(/\\033\[(\d+)A/.exec(buildPromptCommand(cols, cursorX))?.[1]);
  for (const [cols, cursorX] of [[40, 37], [80, 0], [80, 22], [120, 5], [33, 32]] as const) {
    expect(rowsOf(cols, cursorX)).toBe(Math.ceil((cursorX + echoed(cols, cursorX).length) / cols));
  }
  const full = echoed(4096, 0).length;
  expect(rowsOf(full, 0)).toBe(1);
  expect(rowsOf(full, 1)).toBe(2);
});

it("reads terminal dimensions when sending instead of when connecting", () => {
  const write = vi.fn(async () => undefined);
  let cols = 80;
  let cursorX = 0;
  const sender = createPromptCommandSender(() => true, write, vi.fn(), () => ({ cols, cursorX }));
  sender.connect(7);
  sender.receiveData();
  cols = 43;
  cursorX = 21;
  vi.advanceTimersByTime(400);
  expect(write).toHaveBeenCalledExactlyOnceWith(7, buildPromptCommand(43, 21));
});
