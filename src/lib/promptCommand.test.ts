import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPromptCommandSender, SSH_PROMPT_COMMAND } from "./promptCommand";

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
  expect(write).toHaveBeenCalledExactlyOnceWith(42, SSH_PROMPT_COMMAND);
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
  expect(write).toHaveBeenCalledExactlyOnceWith(1, SSH_PROMPT_COMMAND);
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
