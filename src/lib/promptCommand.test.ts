import { expect, it, vi } from "vitest";
import { createPromptCommandSender, SSH_PROMPT_COMMAND } from "./promptCommand";

it("sends the exact one-time Bash prompt command", () => {
  const expected = String.raw` export PROMPT_COMMAND='printf "\033]7;file://%s%s\007" "$HOSTNAME" "$PWD"'"${"${PROMPT_COMMAND:+;$PROMPT_COMMAND}"}"` + "\r";
  expect(SSH_PROMPT_COMMAND).toBe(expected);
});

it.each([true, false])("sends once when data precedes connection: %s", dataFirst => {
  const write = vi.fn(async (_id: number, _data: string) => undefined);
  const sender = createPromptCommandSender(() => true, write, vi.fn());
  if (dataFirst) sender.receiveData(); else sender.connect(42);
  expect(write).not.toHaveBeenCalled();
  if (dataFirst) sender.connect(42); else sender.receiveData();
  sender.receiveData();
  expect(write).toHaveBeenCalledExactlyOnceWith(42, SSH_PROMPT_COMMAND);
});

it("does not inject after cleanup or while disabled", () => {
  const write = vi.fn(async (_id: number, _data: string) => undefined);
  const disposed = createPromptCommandSender(() => true, write, vi.fn());
  disposed.receiveData();
  disposed.dispose();
  disposed.connect(42);
  const disabled = createPromptCommandSender(() => false, write, vi.fn());
  disabled.connect(43);
  disabled.receiveData();
  expect(write).not.toHaveBeenCalled();
});

it("reports write failures without retrying the shell command", async () => {
  const error = new Error("write failed");
  const report = vi.fn();
  const write = vi.fn(async () => { throw error; });
  const sender = createPromptCommandSender(() => true, write, report);
  sender.connect(1);
  sender.receiveData();
  await Promise.resolve();
  expect(report).toHaveBeenCalledWith(error);
  sender.receiveData();
  expect(write).toHaveBeenCalledTimes(1);
});
