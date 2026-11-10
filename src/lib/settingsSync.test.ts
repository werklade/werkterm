import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, serializeSettings, type Settings } from "./settings";
import { conflictReason, SettingsSync, enableWriter, fileSettingsIo, finishWrite, hasOutstandingWrite, initialWriter, queueWrite, setMigrateFlag, takeMigrateFlag, takePending } from "./settingsSync";
import { settingsConflict, type FileStamp, type LoadedSettingsFile } from "./dataDir";

const withFont = (fontSize: number): Settings => ({ ...defaultSettings, fontSize });
const stamp = (n: number): FileStamp => ({ modifiedMs: n, size: n });
const fileOf = (settings: Settings, n = 1): LoadedSettingsFile => ({ json: serializeSettings(settings), ...stamp(n) });
const fileWithFont = (fontSize: number, n = 1) => fileOf(withFont(fontSize), n);

interface IoOverrides { load?: () => Promise<LoadedSettingsFile | null>; save?: (json: string, base: FileStamp | null) => Promise<FileStamp>; readCache?: () => string | null }
function makeIo(over: IoOverrides = {}) {
  const load: () => Promise<LoadedSettingsFile | null> = over.load ?? (async () => fileWithFont(14));
  const save: (json: string, base: FileStamp | null) => Promise<FileStamp> = over.save ?? (async () => stamp(99));
  const readCache: () => string | null = over.readCache ?? (() => null);
  const writeCache = (_settings: Settings): void => undefined;
  return { load: vi.fn(load), save: vi.fn(save), readCache: vi.fn(readCache), writeCache: vi.fn(writeCache) };
}
const savedFonts = (io: ReturnType<typeof makeIo>) => io.save.mock.calls.map(([json]) => (JSON.parse(json) as { fontSize: number }).fontSize);

describe("writer state", () => {
  it("accepts nothing until loading succeeded", () => {
    expect(queueWrite(initialWriter, "{}")).toBe(initialWriter);
  });
  it("keeps only the newest queued change and drops no-ops", () => {
    let state = enableWriter("A");
    state = queueWrite(state, "A");
    expect(hasOutstandingWrite(state)).toBe(false);
    state = queueWrite(queueWrite(state, "B"), "C");
    expect(state.pending).toBe("C");
  });
  it("force queues even an unchanged value (first migration write)", () => {
    expect(queueWrite(enableWriter("A"), "A", true).pending).toBe("A");
  });
  it("does not lose a revert while the previous value is in flight", () => {
    let state = queueWrite(enableWriter("A"), "B");
    state = takePending(state).state;
    state = queueWrite(state, "A");
    expect(state.pending).toBe("A");
  });
  it("re-queues a failed write unless something newer is queued", () => {
    let state = takePending(queueWrite(enableWriter("A"), "B")).state;
    expect(finishWrite(state, "B", false).pending).toBe("B");
    state = queueWrite(state, "C");
    expect(finishWrite(state, "B", false).pending).toBe("C");
    expect(finishWrite(state, "B", true).saved).toBe("B");
  });
});

describe("SettingsSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("does not save before the first successful load", async () => {
    const io = makeIo();
    const sync = new SettingsSync(io, vi.fn());
    sync.schedule(withFont(20));
    await vi.advanceTimersByTimeAsync(1000);
    await sync.flush();
    expect(io.save).not.toHaveBeenCalled();
    expect(io.writeCache).toHaveBeenCalledWith(withFont(20));
  });

  it("keeps working with the cache and never writes when loading fails", async () => {
    const io = makeIo({ load: vi.fn(async () => { throw "Ordner nicht erreichbar"; }) }); const report = vi.fn();
    const sync = new SettingsSync(io, report);
    await expect(sync.load()).resolves.toBeNull();
    expect(report).toHaveBeenCalledWith("Einstellungen nicht geladen: Ordner nicht erreichbar");
    sync.schedule(withFont(20));
    await vi.advanceTimersByTimeAsync(1000);
    await sync.flush();
    expect(io.save).not.toHaveBeenCalled();
    expect(sync.writable).toBe(false);
  });

  it("treats an unreadable settings file as a failed load and does not overwrite it", async () => {
    const io = makeIo({ load: vi.fn(async () => ({ json: "{broken", ...stamp(1) })), readCache: vi.fn(() => '{"fontSize":18}') }); const report = vi.fn();
    const sync = new SettingsSync(io, report);
    await expect(sync.load({ migrate: true })).resolves.toBeNull();
    expect(report).toHaveBeenCalledWith(expect.stringContaining("kein gültiges JSON"));
    sync.schedule(withFont(20));
    await sync.flush();
    expect(io.save).not.toHaveBeenCalled();
  });

  it("returns the file settings and refreshes the cache from them", async () => {
    const io = makeIo({ load: vi.fn(async () => fileWithFont(22)), readCache: vi.fn(() => '{"fontSize":9}') });
    const sync = new SettingsSync(io, vi.fn());
    const loaded = await sync.load();
    expect(loaded?.fontSize).toBe(22);
    expect(io.writeCache).toHaveBeenCalledWith(loaded);
    expect(io.save).not.toHaveBeenCalled();
  });

  it("debounces changes, writes only the last one with the loaded stamp as base and reports the new stamp", async () => {
    const io = makeIo({ load: vi.fn(async () => fileWithFont(14, 7)), save: vi.fn(async () => stamp(8)) }); const onSaved = vi.fn();
    const sync = new SettingsSync(io, vi.fn(), { onSaved });
    await sync.load();
    sync.schedule(withFont(15));
    await vi.advanceTimersByTimeAsync(200);
    sync.schedule(withFont(16));
    await vi.advanceTimersByTimeAsync(299);
    expect(io.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(savedFonts(io)).toEqual([16]);
    expect(io.save.mock.calls[0][1]).toEqual(stamp(7));
    expect(onSaved).toHaveBeenCalledWith(stamp(8));
    expect(sync.hasPending()).toBe(false);
    // The next write is based on the stamp returned by the previous one.
    sync.schedule(withFont(17));
    await sync.flush();
    expect(io.save.mock.calls[1][1]).toEqual(stamp(8));
  });

  it("flush writes outstanding changes at once, e.g. when the window closes", async () => {
    const io = makeIo();
    const sync = new SettingsSync(io, vi.fn());
    await sync.load();
    sync.schedule(withFont(17));
    expect(sync.hasPending()).toBe(true);
    await sync.flush();
    expect(savedFonts(io)).toEqual([17]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(io.save).toHaveBeenCalledTimes(1);
    await sync.flush();
    expect(io.save).toHaveBeenCalledTimes(1);
  });

  it("does not write a value that equals the file content", async () => {
    const io = makeIo();
    const sync = new SettingsSync(io, vi.fn());
    await sync.load();
    sync.schedule(withFont(14));
    await sync.flush();
    expect(io.save).not.toHaveBeenCalled();
  });

  it("reports a failed save as a status message, never as an exception, and retries on the next flush", async () => {
    const save = vi.fn<(json: string, base: FileStamp | null) => Promise<FileStamp>>().mockRejectedValueOnce("Datenträger voll").mockResolvedValue(stamp(5));
    const io = makeIo({ save }); const report = vi.fn(); const onSaved = vi.fn();
    const sync = new SettingsSync(io, report, { onSaved });
    await sync.load();
    sync.schedule(withFont(19));
    await expect(sync.flush()).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith("Einstellungen nicht gespeichert: Datenträger voll");
    expect(onSaved).not.toHaveBeenCalled();
    expect(sync.hasPending()).toBe(true);
    await sync.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  describe("migration from localStorage", () => {
    const stubStorage = (initial: Record<string, string>) => {
      const store = new Map(Object.entries(initial));
      const removeItem = vi.fn((key: string) => { store.delete(key); });
      vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem });
      return { store, removeItem };
    };

    it("with migrate: writes the cache into the missing file once (base null) and keeps the localStorage entry", async () => {
      const { store, removeItem } = stubStorage({ "werkterm.settings": '{"fontSize":21,"shellIntegration":false}' });
      const save = vi.fn(async (_json: string, _base: FileStamp | null) => stamp(2));
      const sync = new SettingsSync({ ...fileSettingsIo, load: async () => null, save }, vi.fn());
      const loaded = await sync.load({ migrate: true });
      expect(loaded).toMatchObject({ fontSize: 21, shellIntegration: false });
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0][1]).toBeNull();
      expect(JSON.parse(save.mock.calls[0][0])).toMatchObject({ fontSize: 21, shellIntegration: false });
      expect(removeItem).not.toHaveBeenCalled();
      expect(store.has("werkterm.settings")).toBe(true);
      // A second start finds the file and does not write again.
      const second = new SettingsSync({ ...fileSettingsIo, load: async () => ({ json: save.mock.calls[0][0], ...stamp(2) }), save }, vi.fn());
      await second.load({ migrate: true });
      expect(save).toHaveBeenCalledTimes(1);
    });

    it("without migrate (target folder has data, or copying was declined): defaults apply and nothing is migrated or written", async () => {
      stubStorage({ "werkterm.settings": '{"fontSize":21,"logFolder":"/home/me/logs"}' });
      const save = vi.fn(async (_json: string, _base: FileStamp | null) => stamp(2));
      const sync = new SettingsSync({ ...fileSettingsIo, load: async () => null, save }, vi.fn());
      const loaded = await sync.load();
      expect(loaded?.fontSize).toBe(defaultSettings.fontSize);
      expect(loaded?.logFolder).toBe("/home/me/logs");
      await sync.flush();
      expect(save).not.toHaveBeenCalled();
    });

    it("a missing file is only created by an active change, never by a derived non-change", async () => {
      const io = makeIo({ load: vi.fn(async () => null) });
      const sync = new SettingsSync(io, vi.fn());
      await sync.load();
      sync.schedule({ ...defaultSettings, logFolder: "/derived/default/logs" });
      await vi.advanceTimersByTimeAsync(1000);
      await sync.flush();
      expect(io.save).not.toHaveBeenCalled();
      sync.schedule(withFont(16));
      await sync.flush();
      expect(savedFonts(io)).toEqual([16]);
      expect(io.save.mock.calls[0][1]).toBeNull();
    });

    it("reads and clears the one-shot copy marker", () => {
      stubStorage({});
      expect(takeMigrateFlag()).toBe(false);
      setMigrateFlag(true);
      expect(takeMigrateFlag()).toBe(true);
      expect(takeMigrateFlag()).toBe(false);
      setMigrateFlag(true); setMigrateFlag(false);
      expect(takeMigrateFlag()).toBe(false);
    });
  });

  it("never writes device-local keys into the file and ignores them when loading", async () => {
    const io = makeIo({ load: vi.fn(async () => ({ json: JSON.stringify({ ...defaultSettings, logFolder: "/other/device" }), ...stamp(1) })), readCache: vi.fn(() => '{"logFolder":"/this/device"}') });
    const sync = new SettingsSync(io, vi.fn());
    expect((await sync.load())?.logFolder).toBe("/this/device");
    sync.schedule({ ...withFont(16), logFolder: "/this/device" });
    await sync.flush();
    expect(JSON.parse(io.save.mock.calls[0][0])).not.toHaveProperty("logFolder");
  });

  it("skips an external reload while an own write is outstanding and reloads when idle", async () => {
    const io = makeIo();
    const sync = new SettingsSync(io, vi.fn());
    await sync.load();
    sync.schedule(withFont(15));
    await expect(sync.reloadExternal()).resolves.toBeNull();
    expect(io.load).toHaveBeenCalledTimes(1);
    await sync.flush();
    io.load.mockResolvedValue(fileWithFont(30, 2));
    expect((await sync.reloadExternal())?.fontSize).toBe(30);
    expect(io.load).toHaveBeenCalledTimes(2);
  });

  it("discards a reload result when an own change appeared while loading", async () => {
    const io = makeIo();
    const sync = new SettingsSync(io, vi.fn());
    await sync.load();
    io.writeCache.mockClear();
    io.load.mockImplementationOnce(async () => { sync.schedule(withFont(15)); return fileWithFont(30, 2); });
    await expect(sync.reloadExternal()).resolves.toBeNull();
    expect(io.writeCache).not.toHaveBeenCalledWith(expect.objectContaining({ fontSize: 30 }));
    expect(sync.hasPending()).toBe(true);
  });

  it("block() discards queued changes and disables writing", async () => {
    const io = makeIo();
    const sync = new SettingsSync(io, vi.fn());
    await sync.load();
    sync.schedule(withFont(15));
    sync.block();
    await vi.advanceTimersByTimeAsync(1000);
    expect(io.save).not.toHaveBeenCalled();
    expect(sync.hasPending()).toBe(false);
  });

  it("lock() (folder switched) permanently stops writing and loading", async () => {
    const io = makeIo();
    const sync = new SettingsSync(io, vi.fn());
    await sync.load();
    sync.lock();
    sync.schedule(withFont(15));
    await sync.flush();
    expect(io.save).not.toHaveBeenCalled();
    expect(await sync.load({ migrate: true })).toBeNull();
    expect(await sync.reloadExternal()).toBeNull();
    expect(io.load).toHaveBeenCalledTimes(1);
    expect(sync.isLocked).toBe(true);
  });

  describe("write conflicts", () => {
    const theirsFile = (n: number) => fileOf({ ...defaultSettings, tuxCount: 7, fontSize: 25 }, n);

    it("reloads, lays the own changed keys over the current file and saves once more", async () => {
      const save = vi.fn<(json: string, base: FileStamp | null) => Promise<FileStamp>>().mockRejectedValueOnce(settingsConflict).mockResolvedValue(stamp(9));
      const io = makeIo({ save }); const report = vi.fn(); const onSaved = vi.fn(); const onMerged = vi.fn();
      const sync = new SettingsSync(io, report, { onSaved, onMerged });
      await sync.load();
      io.load.mockResolvedValue(theirsFile(5));
      sync.schedule(withFont(16));
      await sync.flush();
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[1][1]).toEqual(stamp(5));
      const written = JSON.parse(save.mock.calls[1][0]) as Settings;
      expect(written).toMatchObject({ fontSize: 16, tuxCount: 7 });
      expect(onMerged).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 16, tuxCount: 7 }));
      expect(onSaved).toHaveBeenCalledWith(stamp(9));
      expect(report).not.toHaveBeenCalled();
      expect(sync.hasPending()).toBe(false);
    });

    it("reports a second conflict, keeps the change queued and retries on the next save", async () => {
      const save = vi.fn<(json: string, base: FileStamp | null) => Promise<FileStamp>>()
        .mockRejectedValueOnce(settingsConflict).mockRejectedValueOnce(settingsConflict).mockResolvedValue(stamp(11));
      const io = makeIo({ save }); const report = vi.fn(); const onSaved = vi.fn();
      const sync = new SettingsSync(io, report, { onSaved });
      await sync.load();
      io.load.mockResolvedValue(theirsFile(5));
      sync.schedule(withFont(16));
      await expect(sync.flush()).resolves.toBeUndefined();
      expect(report).toHaveBeenCalledWith(`Einstellungen nicht gespeichert: ${conflictReason}`);
      expect(report).toHaveBeenCalledWith("Einstellungen nicht gespeichert: Datei wurde gleichzeitig geändert");
      expect(onSaved).not.toHaveBeenCalled();
      expect(sync.hasPending()).toBe(true);
      await sync.flush();
      expect(save).toHaveBeenCalledTimes(3);
      expect(onSaved).toHaveBeenCalledWith(stamp(11));
    });

    it("writes the own version when the file vanished meanwhile", async () => {
      const save = vi.fn<(json: string, base: FileStamp | null) => Promise<FileStamp>>().mockRejectedValueOnce(settingsConflict).mockResolvedValue(stamp(3));
      const io = makeIo({ save });
      const sync = new SettingsSync(io, vi.fn());
      await sync.load();
      io.load.mockResolvedValue(null);
      sync.schedule(withFont(16));
      await sync.flush();
      expect(save.mock.calls[1][1]).toBeNull();
      expect(savedFonts(io)).toEqual([16, 16]);
    });
  });
});
