import { beforeEach, expect, it, vi } from "vitest";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { readClipboardText, writeClipboardText } from "./clipboard";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: vi.fn(), writeText: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it("forwards Unicode and empty clipboard text to the native plugin", async () => {
  for (const text of ["", "Grüße 👋\nsecond line"]) {
    vi.mocked(readText).mockResolvedValueOnce(text);
    expect(await readClipboardText()).toBe(text);
    await writeClipboardText(text);
    expect(writeText).toHaveBeenLastCalledWith(text);
  }
  expect(readText).toHaveBeenCalledTimes(2);
});
it("reports readable errors without exposing native provider details", async () => {
  vi.mocked(readText).mockRejectedValueOnce(new Error("NotAllowedError: private"));
  vi.mocked(writeText).mockRejectedValueOnce("native error");
  await expect(readClipboardText()).rejects.toThrow("Zwischenablage nicht verfügbar");
  await expect(writeClipboardText("text")).rejects.toThrow("Zwischenablage nicht verfügbar");
});
