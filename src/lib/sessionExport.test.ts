import { beforeEach, expect, it, vi } from "vitest";
import { chooseSessionExport } from "./sessionExport";
const mocks = vi.hoisted(() => ({ save: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
beforeEach(() => vi.clearAllMocks());
it("cancels without exporting or changing status", async () => {
  mocks.save.mockResolvedValue(null);
  const status = vi.fn();
  await chooseSessionExport([], status);
  expect(mocks.invoke).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
});
it("exports selected ids and reports the destination without passwords", async () => {
  mocks.save.mockResolvedValue("sessions.json"); mocks.invoke.mockResolvedValue(2);
  const status = vi.fn();
  await chooseSessionExport(["a", "b"], status);
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ title: "Sitzungen exportieren", defaultPath: expect.stringMatching(/^werkterm-sitzungen-\d{4}-\d{2}-\d{2}\.json$/) }));
  expect(mocks.invoke).toHaveBeenCalledWith("sessions_export", { ids: ["a", "b"], path: "sessions.json" });
  expect(status).toHaveBeenCalledWith("2 Sitzungen exportiert nach sessions.json (ohne Passwörter)");
});
it("reports export errors", async () => {
  mocks.save.mockResolvedValue("sessions.json"); mocks.invoke.mockRejectedValue("Fehler");
  const status = vi.fn(); await chooseSessionExport([], status);
  expect(status).toHaveBeenCalledWith("Fehler");
});
