import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildPromptCommand, createPromptCommandSender, SSH_PROMPT_COMMAND } from "./promptCommand";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Sender = ReturnType<typeof createPromptCommandSender>;
/** Settle pending promise callbacks without advancing fake timers. */
const flush = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };
/** Connect with a login shell already confirmed as Bash. */
async function connect(sender: Sender, id: number) {
  sender.connect(id, Promise.resolve(true));
  await flush();
}

it.each([
  ["false", () => Promise.resolve(false)],
  ["a rejection", () => Promise.reject(new Error("exec refused"))],
])("never sends when the Bash check yields %s", async (_name, check) => {
  const write = vi.fn(async () => undefined);
  const report = vi.fn();
  const sender = createPromptCommandSender(() => true, write, report);
  sender.connect(1, check());
  await flush();
  sender.receiveData();
  vi.advanceTimersByTime(20000);
  expect(write).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

it("waits while the Bash check is pending and sends once it resolves true", async () => {
  const write = vi.fn(async () => undefined);
  let resolve: (value: boolean) => void = () => undefined;
  const sender = createPromptCommandSender(() => true, write, vi.fn());
  sender.connect(1, new Promise<boolean>(done => { resolve = done; }));
  sender.receiveData();
  vi.advanceTimersByTime(3000);
  await flush();
  expect(write).not.toHaveBeenCalled();
  resolve(true);
  await flush();
  expect(write).toHaveBeenCalledExactlyOnceWith(1, buildPromptCommand(80, 0));
});

it("keeps quiet and prompt conditions after a late true", async () => {
  const write = vi.fn(async () => undefined);
  let resolve: (value: boolean) => void = () => undefined;
  const sender = createPromptCommandSender(() => true, write, vi.fn(), undefined, () => "blocked");
  sender.connect(1, new Promise<boolean>(done => { resolve = done; }));
  sender.receiveData();
  vi.advanceTimersByTime(1000);
  resolve(true);
  await flush();
  vi.advanceTimersByTime(20000);
  expect(write).not.toHaveBeenCalled();
});

it.each(["dispose", "userInput"] as const)("does not send when the Bash check resolves true after %s", async stop => {
  const write = vi.fn(async () => undefined);
  let resolve: (value: boolean) => void = () => undefined;
  const sender = createPromptCommandSender(() => true, write, vi.fn());
  sender.connect(1, new Promise<boolean>(done => { resolve = done; }));
  sender.receiveData();
  vi.advanceTimersByTime(1000);
  sender[stop]();
  resolve(true);
  await flush();
  vi.advanceTimersByTime(20000);
  expect(write).not.toHaveBeenCalled();
});

it("does not send when the Bash check resolves true after giving up", async () => {
  const write = vi.fn(async () => undefined);
  let resolve: (value: boolean) => void = () => undefined;
  const sender = createPromptCommandSender(() => true, write, vi.fn());
  sender.connect(1, new Promise<boolean>(done => { resolve = done; }));
  sender.receiveData();
  vi.advanceTimersByTime(15000);
  resolve(true);
  await flush();
  expect(write).not.toHaveBeenCalled();
});

it("uses a single-line byte-encoding Bash hook", () => {
  expect(SSH_PROMPT_COMMAND).toContain('local LC_ALL=C p="$PWD"');
  expect(SSH_PROMPT_COMMAND).toContain('i<${#p}');
  expect(SSH_PROMPT_COMMAND).toContain('c="${p:i:1}"');
  expect(SSH_PROMPT_COMMAND).toContain("[-_.~a-zA-Z0-9/]");
  expect(SSH_PROMPT_COMMAND).toContain("printf -v c '%%%02X' \"'$c\"");
  expect(SSH_PROMPT_COMMAND).toContain('__werkterm_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}');
  // Child shells such as `pct enter` inherit exported variables but not functions.
  expect(SSH_PROMPT_COMMAND).not.toContain("export PROMPT_COMMAND");
  expect(SSH_PROMPT_COMMAND).toContain('PROMPT_COMMAND="declare -F __werkterm_osc7 >/dev/null && __werkterm_osc7');
  expect(SSH_PROMPT_COMMAND.endsWith("\r")).toBe(true);
  expect(SSH_PROMPT_COMMAND).not.toContain("\n");
});

it.each([true, false])("waits for 400 ms of quiet and sends once, data first: %s", async dataFirst => {
  const write = vi.fn(async (_id: number, _data: string) => undefined);
  const sender = createPromptCommandSender(() => true, write, vi.fn());
  if (dataFirst) sender.receiveData(); else await connect(sender, 42);
  vi.advanceTimersByTime(200);
  if (dataFirst) await connect(sender, 42); else sender.receiveData();
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

it("removes the line from the history exactly once, before the printf suffix", () => {
  const guard = "; [[ $(history 1) == *__werkterm_osc7*PROMPT_COMMAND* ]] && history -d $HISTCMD 2>/dev/null";
  expect(SSH_PROMPT_COMMAND.split(guard)).toHaveLength(2);
  const command = buildPromptCommand(80, 0);
  expect(command.split(guard)).toHaveLength(2);
  expect(command.indexOf(guard)).toBeGreaterThan(command.indexOf("PROMPT_COMMAND=\""));
  expect(command).toMatch(/; printf '\\033\[\d+A\\r\\033\[J'\r$/);
  expect(command.indexOf(guard) + guard.length).toBe(command.indexOf("; printf '\\033["));
  expect(command).not.toContain("\n");
});

it("never sends while output keeps flowing, even after the deadline", async () => {
  const write = vi.fn(async () => undefined);
  const sender = createPromptCommandSender(() => true, write, vi.fn());
  await connect(sender, 1);
  for (let i = 0; i < 80; i++) { sender.receiveData(); vi.advanceTimersByTime(100); }
  expect(write).not.toHaveBeenCalled();
  // The last chunk arrived 100 ms ago, so 300 ms of quiet remain.
  vi.advanceTimersByTime(299);
  expect(write).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(write).toHaveBeenCalledExactlyOnceWith(1, buildPromptCommand(80, 0));
});

it("sends after quiet when the prompt is recognised", async () => {
  const write = vi.fn(async () => undefined);
  const sender = createPromptCommandSender(() => true, write, vi.fn(), undefined, () => "prompt");
  await connect(sender, 1);
  sender.receiveData();
  vi.advanceTimersByTime(399);
  expect(write).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(write).toHaveBeenCalledTimes(1);
});

it("waits for the prompt past the quiet period and sends once after the deadline", async () => {
  const write = vi.fn(async () => undefined);
  let ready = false;
  const sender = createPromptCommandSender(() => true, write, vi.fn(), undefined, () => (ready ? "prompt" : "other"));
  await connect(sender, 1);
  sender.receiveData();
  vi.advanceTimersByTime(4900);
  expect(write).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(write).toHaveBeenCalledExactlyOnceWith(1, buildPromptCommand(80, 0));
  sender.receiveData();
  vi.advanceTimersByTime(6000);
  expect(write).toHaveBeenCalledTimes(1);
});

it("sends when the prompt appears after a slow pause", async () => {
  const write = vi.fn(async () => undefined);
  let ready = false;
  const sender = createPromptCommandSender(() => true, write, vi.fn(), undefined, () => (ready ? "prompt" : "other"));
  await connect(sender, 1);
  sender.receiveData();
  vi.advanceTimersByTime(1000);
  expect(write).not.toHaveBeenCalled();
  ready = true;
  sender.receiveData();
  vi.advanceTimersByTime(400);
  expect(write).toHaveBeenCalledTimes(1);
});

it("requires first data even when the deadline expires", async () => {
  const write = vi.fn(async () => undefined);
  const sender = createPromptCommandSender(() => true, write, vi.fn(), undefined, () => "other");
  await connect(sender, 1);
  vi.advanceTimersByTime(6000);
  expect(write).not.toHaveBeenCalled();
  sender.receiveData();
  vi.advanceTimersByTime(399);
  expect(write).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(write).toHaveBeenCalledTimes(1);
});

it("does not inject after cleanup or while disabled", async () => {
  const write = vi.fn(async () => undefined);
  const disposed = createPromptCommandSender(() => true, write, vi.fn());
  await connect(disposed, 42); disposed.receiveData(); disposed.dispose();
  const disabled = createPromptCommandSender(() => false, write, vi.fn());
  await connect(disabled, 43); disabled.receiveData();
  vi.advanceTimersByTime(6000);
  expect(write).not.toHaveBeenCalled();
});

it("reports write failures without retrying", async () => {
  const error = new Error("write failed");
  const report = vi.fn();
  const write = vi.fn(async () => { throw error; });
  const sender = createPromptCommandSender(() => true, write, report);
  await connect(sender, 1); sender.receiveData();
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

it("reads terminal dimensions when sending instead of when connecting", async () => {
  const write = vi.fn(async () => undefined);
  let cols = 80;
  let cursorX = 0;
  const sender = createPromptCommandSender(() => true, write, vi.fn(), () => ({ cols, cursorX }));
  await connect(sender, 7);
  sender.receiveData();
  cols = 43;
  cursorX = 21;
  vi.advanceTimersByTime(400);
  expect(write).toHaveBeenCalledExactlyOnceWith(7, buildPromptCommand(43, 21));
});

it("never sends into a password prompt, question or full-screen program", async () => {
  const write = vi.fn(async () => undefined);
  const sender = createPromptCommandSender(() => true, write, vi.fn(), undefined, () => "blocked");
  await connect(sender, 1);
  sender.receiveData();
  vi.advanceTimersByTime(20000);
  expect(write).not.toHaveBeenCalled();
});

it("stops as soon as the user types", async () => {
  const write = vi.fn(async () => undefined);
  const sender = createPromptCommandSender(() => true, write, vi.fn(), undefined, () => "other");
  await connect(sender, 1);
  sender.receiveData();
  vi.advanceTimersByTime(1000);
  sender.userInput();
  vi.advanceTimersByTime(10000);
  expect(write).not.toHaveBeenCalled();
});

it("gives up after 15 seconds without a usable quiet period", async () => {
  const write = vi.fn(async () => undefined);
  const sender = createPromptCommandSender(() => true, write, vi.fn());
  await connect(sender, 1);
  for (let i = 0; i < 200; i++) { sender.receiveData(); vi.advanceTimersByTime(100); }
  vi.advanceTimersByTime(1000);
  expect(write).not.toHaveBeenCalled();
});
