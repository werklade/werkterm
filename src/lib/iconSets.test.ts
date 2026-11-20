import { afterEach, expect, it, vi } from "vitest";
import { activateIconSet, getIconSnapshot, iconSvg, reloadIconSet, setIconSet, subscribeIcons } from "./iconSets";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
afterEach(() => { setIconSet("Standard"); vi.clearAllMocks(); });
it("switches snapshots, notifies subscribers and falls back for missing names", () => {
  const changed = vi.fn(); const unsubscribe = subscribeIcons(changed);
  const standard = { folder: "standard folder", tux: "standard tux" };
  setIconSet("custom", { folder: "custom folder" });
  expect(getIconSnapshot().name).toBe("custom");
  expect(iconSvg(getIconSnapshot(), "folder", standard)).toBe("custom folder");
  expect(iconSvg(getIconSnapshot(), "tux", standard)).toBe("standard tux");
  setIconSet("Werklade");
  expect(iconSvg(getIconSnapshot(), "folder", standard)).toBe("standard folder");
  expect(changed).toHaveBeenCalledTimes(2); unsubscribe();
  setIconSet("Standard"); expect(changed).toHaveBeenCalledTimes(2);
});
it("ignores a stale imported load after switching back to a built-in set", async () => {
  let resolve!: (value: Record<string, string>) => void;
  vi.mocked(invoke).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const pending = activateIconSet("custom");
  await activateIconSet("Werklade"); resolve({ tux: "custom" }); await pending;
  expect(getIconSnapshot()).toEqual({ name: "Werklade", overrides: {} });
});
it("reloads the active imported set and reports only real changes", async () => {
  setIconSet("custom", { tux: "old", folder: "f" });
  const changed = vi.fn(); const unsubscribe = subscribeIcons(changed);
  vi.mocked(invoke).mockResolvedValueOnce({ folder: "f", tux: "old" });
  expect(await reloadIconSet("custom")).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValueOnce({ tux: "new" });
  expect(await reloadIconSet("custom")).toBe(true);
  expect(getIconSnapshot()).toEqual({ name: "custom", overrides: { tux: "new" } });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(await reloadIconSet("Werklade")).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(2);
  unsubscribe();
});
it("falls back to Standard when the active imported set is gone", async () => {
  setIconSet("custom", { tux: "old" });
  vi.mocked(invoke).mockRejectedValueOnce("ICON_SET_MISSING");
  await expect(reloadIconSet("custom")).rejects.toBe("ICON_SET_MISSING");
  expect(getIconSnapshot()).toEqual({ name: "Standard", overrides: {} });
});
