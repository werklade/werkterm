import { describe, expect, it, vi } from "vitest";
import { runSwitch, type SwitchSteps } from "./dataDirSwitch";

function steps(over: Partial<SwitchSteps> = {}) {
  const calls: string[] = [];
  const record = (name: string, fail?: string) => vi.fn(async () => { calls.push(name); if (fail) throw fail; });
  const all = {
    flushSettings: record("flush"), stopTunnels: record("tunnels"), saveLastTabs: record("tabs"), stopLogs: record("logs"),
    setDataDir: record("set"), restart: record("restart"),
    lock: vi.fn(() => { calls.push("lock"); }), onRestartFailed: vi.fn(),
    ...over,
  } satisfies SwitchSteps;
  return { all, calls };
}

describe("runSwitch", () => {
  it("runs everything that can fail first and data_dir_set directly before the restart", async () => {
    const { all, calls } = steps();
    await runSwitch(all);
    expect(calls).toEqual(["flush", "tunnels", "tabs", "logs", "set", "lock", "restart"]);
  });
  it("does not switch or lock when an earlier step fails", async () => {
    for (const failing of ["flushSettings", "stopTunnels", "saveLastTabs", "stopLogs"] as const) {
      const { all, calls } = steps({ [failing]: vi.fn(async () => { throw "Fehler"; }) });
      await expect(runSwitch(all)).rejects.toBe("Fehler");
      expect(calls).not.toContain("set");
      expect(all.lock).not.toHaveBeenCalled();
    }
  });
  it("does not lock or restart when data_dir_set fails", async () => {
    const { all } = steps({ setDataDir: vi.fn(async () => { throw "Tunnel vor dem Wechsel stoppen"; }) });
    await expect(runSwitch(all)).rejects.toBe("Tunnel vor dem Wechsel stoppen");
    expect(all.lock).not.toHaveBeenCalled();
    expect(all.restart).not.toHaveBeenCalled();
  });
  it("keeps the lock and reports a failed restart instead of throwing", async () => {
    const { all } = steps({ restart: vi.fn(async () => { throw "Neustart nicht möglich"; }) });
    await expect(runSwitch(all)).resolves.toBeUndefined();
    expect(all.lock).toHaveBeenCalledTimes(1);
    expect(all.onRestartFailed).toHaveBeenCalledWith("Neustart nicht möglich");
  });
});
