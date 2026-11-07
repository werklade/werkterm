import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { cancelSshConnect, connectSsh, type ConnectOptions } from "./ssh";

beforeEach(() => invoke.mockReset());
it("passes the frontend-selected token and returns the connected mode", async () => {
  const options = { target: "user@host", connectToken: 37, cols: 80, rows: 24 } as ConnectOptions;
  invoke.mockResolvedValue({ id: 12, mode: "exec" });
  await expect(connectSsh(options)).resolves.toEqual({ id: 12, mode: "exec" });
  expect(invoke).toHaveBeenCalledWith("ssh_connect", { ...options, sessionId: null });
});
it("passes the saved session id to use its configured authentication", async () => {
  const options = { target: "user@host", sessionId: "saved-session", connectToken: 38, cols: 80, rows: 24 } as ConnectOptions;
  invoke.mockResolvedValue({ id: 13, mode: "SFTP" });
  await expect(connectSsh(options)).resolves.toEqual({ id: 13, mode: "SFTP" });
  expect(invoke).toHaveBeenCalledWith("ssh_connect", options);
});
it("cancels by token before a session id exists", async () => {
  invoke.mockResolvedValue(undefined);
  await cancelSshConnect(37);
  expect(invoke).toHaveBeenCalledWith("ssh_cancel_connect", { connectToken: 37 });
});
