import { describe, expect, it } from "vitest";
import { changedFiles, choicePath, describeInspect, mergeEntry, planReload, shouldCheck, type DataDirInspect, type FileFingerprint } from "./dataDir";

const inspect = (over: Partial<DataDirInspect> = {}): DataDirInspect => ({ exists: true, isDir: true, writable: true, hasData: false, sameAsCurrent: false, ...over });
const fp = (name: string, modifiedMs: number, size = 10): FileFingerprint => ({ name, modifiedMs, size });
const files = (sessions = 1, tunnels = 1, macros = 1, settings = 1): FileFingerprint[] =>
  [fp("sessions.json", sessions), fp("tunnels.json", tunnels), fp("macros.json", macros), fp("settings.json", settings)];

describe("describeInspect", () => {
  it("uses existing data and hides the copy option", () => {
    expect(describeInspect(inspect({ hasData: true }), { allowSame: false })).toEqual({
      tone: "info", message: "Vorhandene Werkterm-Daten gefunden; sie werden verwendet.", canConfirm: true, showCopy: false,
    });
  });
  it("offers copying for an empty or new folder", () => {
    for (const info of [inspect(), inspect({ exists: false, isDir: false })]) {
      expect(describeInspect(info, { allowSame: false })).toMatchObject({ tone: "info", canConfirm: true, showCopy: true });
    }
  });
  it("reports a folder that is not writable as an error and blocks confirming", () => {
    expect(describeInspect(inspect({ writable: false, hasData: true }), { allowSame: false })).toMatchObject({ tone: "error", canConfirm: false, showCopy: false, message: "Der Ordner ist nicht beschreibbar." });
  });
  it("reports a path that is a file", () => {
    expect(describeInspect(inspect({ isDir: false }), { allowSame: false })).toMatchObject({ tone: "error", canConfirm: false, message: "Der Pfad ist kein Ordner." });
  });
  it("rejects the current folder when changing but accepts it during setup", () => {
    expect(describeInspect(inspect({ sameAsCurrent: true }), { allowSame: false })).toMatchObject({ canConfirm: false, tone: "info" });
    expect(describeInspect(inspect({ sameAsCurrent: true }), { allowSame: true }).canConfirm).toBe(true);
  });
  it("sends null for the default folder", () => {
    expect(choicePath({ kind: "default", path: "/home/u/.local/share/werkterm" })).toBeNull();
    expect(choicePath({ kind: "folder", path: "/srv/cloud" })).toBe("/srv/cloud");
  });
});

describe("fingerprint comparison", () => {
  it("treats the first sample as a baseline", () => {
    expect(changedFiles(null, files())).toEqual([]);
  });
  it("detects changed modification time or size, per file", () => {
    expect(changedFiles(files(), files())).toEqual([]);
    expect(changedFiles(files(), files(2))).toEqual(["sessions.json"]);
    expect(changedFiles(files(), [fp("sessions.json", 1), fp("tunnels.json", 1), fp("macros.json", 1, 99), fp("settings.json", 5)])).toEqual(["macros.json", "settings.json"]);
  });
  it("detects files that appear or disappear", () => {
    expect(changedFiles(files().slice(0, 3), files())).toEqual(["settings.json"]);
    expect(changedFiles(files(), files().slice(1))).toEqual(["sessions.json"]);
  });
  it("replaces one entry so an own write is not reloaded", () => {
    const baseline = files();
    const fresh = files(7, 7, 7, 7);
    const merged = mergeEntry(baseline, fresh, "settings.json");
    expect(changedFiles(merged, fresh)).toEqual(["sessions.json", "tunnels.json", "macros.json"]);
    expect(mergeEntry(null, fresh, "settings.json")).toBeNull();
    expect(mergeEntry(baseline, files().slice(0, 3), "settings.json")?.some(e => e.name === "settings.json")).toBe(false);
  });
  it("reloads settings.json only when no own write is outstanding", () => {
    const next = files(1, 1, 1, 9);
    expect(planReload(files(), next, false)).toEqual({ reload: ["settings.json"], baseline: next });
    const held = planReload(files(), files(2, 1, 1, 9), true);
    expect(held.reload).toEqual(["sessions.json"]);
    expect(held.baseline.find(e => e.name === "settings.json")?.modifiedMs).toBe(1);
    expect(held.baseline.find(e => e.name === "sessions.json")?.modifiedMs).toBe(2);
  });
  it("plans no reload for the baseline sample", () => {
    expect(planReload(null, files(), false)).toEqual({ reload: [], baseline: files() });
  });
  it("checks at most every five seconds", () => {
    expect(shouldCheck(10_000, 0)).toBe(true);
    expect(shouldCheck(4_999, 0)).toBe(false);
    expect(shouldCheck(5_000, 0)).toBe(true);
    expect(shouldCheck(1_000, 0, 500)).toBe(true);
  });
});
