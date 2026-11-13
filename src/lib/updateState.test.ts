import { describe, expect, it, vi } from "vitest";
import {
  aptCommand, canCloseUpdateDialog, createStartupChecker, describeInstall, formatPubDate, initialUpdateState, installKindLabel, interpretCheck, invalidAnswerMessage,
  normalizeProgress, notesMaxChars, notesMaxLines, progressPercent, progressText, sanitizeNotes, sanitizeVersion, shouldCheckOnStart, updateAction, updateReducer,
  updateStartNote, restartHints, withStoppedNote, isRestartRequired, restartRequiredMessage, transfersMessage, aptRepoNote, guardLate, startCheckEnabled, type UpdateCheck, type UpdateEvent, type UpdateInfo, type UpdateState,
} from "./updateState";
import { createMenus } from "./actions";
import { defaultSettings, normalizeSettings, serializeSettings } from "./settings";

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({ currentVersion: "0.3.0", installKind: "appimage", selfUpdate: true, channel: "stable", configured: true, canInstall: true, blockedReason: null, ...over });
const available = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({ available: true, version: "0.4.0", notes: "Neu: Update-Prüfung", pubDate: "2026-11-10T12:00:00Z", ...over });
const run = (events: UpdateEvent[], from: UpdateState = initialUpdateState): UpdateState => events.reduce(updateReducer, from);
const offer = (over: Partial<UpdateInfo> = {}) => run([{ type: "info", info: info(over) }, { type: "checked", check: available() }]);

describe("update state machine", () => {
  it("starts loading, checks after update_info and ends up to date", () => {
    expect(initialUpdateState.phase).toBe("loading");
    expect(run([{ type: "info", info: info() }]).phase).toBe("checking");
    expect(run([{ type: "info", info: info() }, { type: "checked", check: { available: false, version: null, notes: null, pubDate: null } }]).phase).toBe("current");
  });
  it("does not check when the build is not configured", () => {
    const state = run([{ type: "info", info: info({ configured: false }) }]);
    expect(state.phase).toBe("notConfigured");
    // a late answer cannot start anything
    expect(updateReducer(state, { type: "checked", check: available() })).toBe(state);
  });
  it("shows an available update with sanitized data", () => {
    const state = offer();
    expect(state.phase).toBe("available");
    if (state.phase === "available") expect(state.update).toMatchObject({ version: "0.4.0", notes: "Neu: Update-Prüfung", pubDate: "2026-11-10T12:00:00Z" });
  });
  it("rejects an available answer without a usable version", () => {
    const state = run([{ type: "info", info: info() }, { type: "checked", check: available({ version: "<>" }) }]);
    expect(state).toMatchObject({ phase: "error", message: invalidAnswerMessage(), retry: "check" });
  });
  it("turns failures into the error phase with the matching retry target", () => {
    expect(run([{ type: "failed", message: "x" }])).toMatchObject({ phase: "error", info: null, retry: "info" });
    expect(run([{ type: "info", info: info() }, { type: "failed", message: "Keine Verbindung" }])).toMatchObject({ phase: "error", message: "Keine Verbindung", retry: "check" });
    expect(run([{ type: "install" }, { type: "failed", message: "Download fehlgeschlagen" }], offer())).toMatchObject({ phase: "error", retry: "install" });
  });
  it("retries: check again, reload info, or install again", () => {
    const checkFailed = run([{ type: "info", info: info() }, { type: "failed", message: "x" }]);
    expect(updateReducer(checkFailed, { type: "retry" }).phase).toBe("checking");
    expect(updateReducer(run([{ type: "failed", message: "x" }]), { type: "retry" }).phase).toBe("loading");
    const installFailed = run([{ type: "install" }, { type: "failed", message: "x" }], offer());
    expect(updateReducer(installFailed, { type: "retry" }).phase).toBe("installing");
    expect(updateReducer(offer(), { type: "retry" }).phase).toBe("available");
  });
  it("installs only when the backend can self-update", () => {
    expect(run([{ type: "install" }], offer()).phase).toBe("installing");
    expect(run([{ type: "install" }], offer({ selfUpdate: false, installKind: "deb" })).phase).toBe("available");
    expect(run([{ type: "install" }], offer({ selfUpdate: false, installKind: "rpm" })).phase).toBe("available");
  });
  it("tracks progress, then restarts; progress outside the install is ignored", () => {
    const installing = run([{ type: "install" }, { type: "progress", progress: { downloaded: 50, total: 200 } }], offer());
    expect(installing).toMatchObject({ phase: "installing", progress: { downloaded: 50, total: 200 } });
    expect(updateReducer(installing, { type: "installed" }).phase).toBe("restarting");
    const idle = offer();
    expect(updateReducer(idle, { type: "progress", progress: { downloaded: 1, total: 2 } })).toBe(idle);
  });
  it("returns to the offer when a confirmation before the install was declined", () => {
    expect(run([{ type: "install" }, { type: "declined" }], offer()).phase).toBe("available");
  });
  it("blocks closing during install and restart only", () => {
    expect(canCloseUpdateDialog(offer())).toBe(true);
    expect(canCloseUpdateDialog(initialUpdateState)).toBe(true);
    expect(canCloseUpdateDialog(run([{ type: "install" }], offer()))).toBe(false);
    expect(canCloseUpdateDialog(run([{ type: "install" }, { type: "installed" }], offer()))).toBe(false);
    expect(canCloseUpdateDialog(run([{ type: "install" }, { type: "failed", message: "x" }], offer()))).toBe(true);
  });
  it("ignores a second install click", () => {
    const installing = run([{ type: "install" }], offer());
    expect(updateReducer(installing, { type: "install" })).toBe(installing);
  });
});

describe("update action by installation", () => {
  it("self-update wins, deb gets apt, everything else a download address", () => {
    expect(updateAction({ selfUpdate: true, canInstall: true, installKind: "nsis" })).toBe("install");
    expect(updateAction({ selfUpdate: true, canInstall: true, installKind: "appimage" })).toBe("install");
    expect(updateAction({ selfUpdate: false, canInstall: false, installKind: "deb" })).toBe("apt");
    expect(updateAction({ selfUpdate: false, canInstall: false, installKind: "rpm" })).toBe("download");
    expect(updateAction({ selfUpdate: false, canInstall: false, installKind: "other" })).toBe("download");
  });
  it("describes the installation for the About dialog", () => {
    expect(installKindLabel("deb")).toBe("DEB-Paket");
    expect(describeInstall({ installKind: "appimage", channel: "stable" })).toBe("AppImage");
    expect(describeInstall({ installKind: "msi", channel: "test" })).toBe("Windows-Installer (MSI), Testkanal");
  });
});

describe("install notes and errors", () => {
  it("names only what was actually stopped and keeps the backend text", () => {
    const none = { tunnels: false, logs: false };
    expect(withStoppedNote("Signatur des Updates ist ungültig.", none)).toBe("Signatur des Updates ist ungültig.");
    expect(withStoppedNote("Signatur des Updates ist ungültig.", { ...none, tunnels: true })).toBe("Signatur des Updates ist ungültig. Gestoppte Tunnel wurden nicht neu gestartet.");
    expect(withStoppedNote("Update-Server nicht erreichbar", { ...none, logs: true })).toBe("Update-Server nicht erreichbar. Gestoppte Protokolle wurden nicht neu gestartet.");
    expect(withStoppedNote("Fehler.", { tunnels: true, logs: true })).toBe("Fehler. Gestoppte Tunnel und Protokolle wurden nicht neu gestartet.");
  });
  it("recognizes the restart-required error exactly", () => {
    expect(isRestartRequired("UPDATE_RESTART_REQUIRED")).toBe(true);
    expect(isRestartRequired(new Error("UPDATE_RESTART_REQUIRED"))).toBe(true);
    expect(isRestartRequired("UPDATE_RESTART_REQUIRED.")).toBe(false);
    expect(isRestartRequired("Update-Server nicht erreichbar")).toBe(false);
    expect(restartRequiredMessage()).toBe("Das Update wurde nicht installiert. Werkterm muss neu gestartet werden.");
  });
  it("words the transfer question", () => {
    expect(transfersMessage(3)).toBe("3 Übertragungen laufen und werden abgebrochen.");
    expect(transfersMessage(1)).toBe("Eine Übertragung läuft und wird abgebrochen.");
  });
  it("blocks the install when the build can self-update but not here (before anything is stopped)", () => {
    const blocked = { selfUpdate: true, installKind: "appimage", canInstall: false } as const;
    expect(updateAction(blocked)).toBe("blocked");
    expect(updateAction({ ...blocked, canInstall: true })).toBe("install");
    const state = offer({ canInstall: false, blockedReason: "Ordner nicht beschreibbar" });
    expect(updateReducer(state, { type: "install" })).toBe(state);
  });
  it("the apt command upgrades only and needs the repository", () => {
    expect(aptCommand).toBe("sudo apt update && sudo apt install --only-upgrade werkterm");
    expect(aptRepoNote()).toBe("Funktioniert nur, wenn das Werklade-Repository eingebunden ist.");
  });
  it("drops late answers after the dialog was closed", () => {
    let open = true;
    const handler = vi.fn();
    const guarded = guardLate(() => open, handler);
    guarded("früh");
    open = false;
    guarded("spät");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("früh");
  });
  it("lists the restart hints per installation", () => {
    expect(restartHints("appimage")).toEqual(["Werkterm startet danach neu. Offene Verbindungen werden getrennt."]);
    expect(restartHints("nsis")).toEqual(["Werkterm wird beendet und nach dem Update neu gestartet. Offene Verbindungen werden getrennt."]);
    expect(restartHints("msi")).toHaveLength(2);
    expect(restartHints("msi")[1]).toBe("Windows fragt nach dem Beenden nach Administratorrechten. Bei Ablehnung bleibt die bisherige Version installiert; Werkterm dann von Hand starten.");
  });
  it("shows backend error texts unchanged", () => {
    const state = run([{ type: "info", info: info() }, { type: "failed", message: "Update-Server nicht erreichbar" }]);
    expect(state).toMatchObject({ phase: "error", message: "Update-Server nicht erreichbar" });
  });
  it("up to date depends on 'available' only, even with an announced version", () => {
    expect(interpretCheck({ available: false, version: "0.3.0", notes: "alt", pubDate: "2026-01-01T00:00:00Z" })).toEqual({ ok: true, update: null });
  });
});

describe("notes sanitizing", () => {
  it("keeps line breaks and normalizes CRLF, tabs stay", () => {
    expect(sanitizeNotes("Zeile 1\r\nZeile 2\rZeile 3\n\tEingerückt").text).toBe("Zeile 1\nZeile 2\nZeile 3\n\tEingerückt");
  });
  it("leaves markup as text (nothing is interpreted)", () => {
    expect(sanitizeNotes("<img src=x onerror=alert(1)> **fett** [Link](javascript:x)").text).toBe("<img src=x onerror=alert(1)> **fett** [Link](javascript:x)");
  });
  it("removes control, bidi-override and zero-width characters", () => {
    expect(sanitizeNotes("a\u0000b\u001b[31mc‮d​e\u0085f﻿").text).toBe("ab[31mcdef");
  });
  it("collapses runs of blank lines and trims", () => {
    expect(sanitizeNotes("\n\na \n\n\n\n\nb \n\n").text).toBe("a\n\nb");
  });
  it("caps the number of lines and marks the cut", () => {
    const text = Array.from({ length: notesMaxLines + 20 }, (_, i) => `Zeile ${i}`).join("\n");
    const result = sanitizeNotes(text);
    expect(result.truncated).toBe(true);
    expect(result.text.split("\n")).toHaveLength(notesMaxLines + 1);
    expect(result.text.endsWith("\n…")).toBe(true);
  });
  it("caps the length without splitting a surrogate pair", () => {
    const text = "a".repeat(notesMaxChars - 1) + "😀" + "b".repeat(50);
    const result = sanitizeNotes(text);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("a".repeat(notesMaxChars - 1) + "\n…");
    expect(sanitizeNotes("kurz")).toEqual({ text: "kurz", truncated: false });
  });
  it("handles missing notes", () => {
    expect(sanitizeNotes(null)).toEqual({ text: "", truncated: false });
    expect(sanitizeNotes(undefined).text).toBe("");
  });
  it("reduces the version to version characters", () => {
    expect(sanitizeVersion(" 1.2.3-rc.1+build ")).toBe("1.2.3-rc.1+build");
    expect(sanitizeVersion("1.2.3<script>")).toBe("1.2.3script");
    expect(sanitizeVersion("<>")).toBeNull();
    expect(sanitizeVersion(null)).toBeNull();
    expect(sanitizeVersion("1".repeat(200))).toHaveLength(64);
  });
  it("interprets a check answer", () => {
    expect(interpretCheck({ available: false, version: "9", notes: "x", pubDate: null })).toEqual({ ok: true, update: null });
    const outcome = interpretCheck(available({ notes: null }));
    expect(outcome.ok && outcome.update).toMatchObject({ version: "0.4.0", notes: "" });
  });
});

describe("date and progress", () => {
  it("formats the publication date locally", () => {
    expect(formatPubDate("2026-11-10T12:00:00Z", "de-DE", "UTC")).toBe("10.11.2026");
    expect(formatPubDate(null)).toBeNull();
    expect(formatPubDate("kein Datum")).toBeNull();
  });
  it("computes the percentage and stays indeterminate without a total", () => {
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(0, 200)).toBe(0);
    expect(progressPercent(300, 200)).toBe(100);
    expect(progressPercent(-5, 200)).toBe(0);
    expect(progressPercent(50, null)).toBeNull();
    expect(progressPercent(50, 0)).toBeNull();
    expect(progressPercent(NaN, 100)).toBeNull();
  });
  it("describes the progress as text", () => {
    expect(progressText(512 * 1024, 2 * 1024 * 1024)).toBe("512,0 KB von 2,0 MB (25 %)");
    expect(progressText(1024, null)).toBe("1,0 KB heruntergeladen");
  });
  it("normalizes backend progress messages", () => {
    expect(normalizeProgress({ downloaded: 10, total: 100 })).toEqual({ downloaded: 10, total: 100 });
    expect(normalizeProgress({ downloaded: -1, total: 0 })).toEqual({ downloaded: 0, total: null });
    expect(normalizeProgress({ downloaded: NaN, total: Infinity })).toEqual({ downloaded: 0, total: null });
    expect(normalizeProgress(null)).toEqual({ downloaded: 0, total: null });
  });
});

describe("start check decision", () => {
  it("runs only when switched on, ready and not decided yet", () => {
    expect(shouldCheckOnStart({ enabled: true, dataReady: true, alreadyDecided: false })).toBe(true);
    expect(shouldCheckOnStart({ enabled: false, dataReady: true, alreadyDecided: false })).toBe(false);
    expect(shouldCheckOnStart({ enabled: true, dataReady: false, alreadyDecided: false })).toBe(false);
    expect(shouldCheckOnStart({ enabled: true, dataReady: true, alreadyDecided: true })).toBe(false);
  });
});

describe("start check (no connection without consent)", () => {
  const deps = (over: { check?: () => Promise<UpdateCheck>; info?: () => Promise<UpdateInfo> } = {}) => ({
    info: vi.fn(over.info ?? (async () => info())), check: vi.fn(over.check ?? (async () => available())),
  });
  it("setting off: update_check is not called at start (and not update_info either)", async () => {
    const d = deps();
    const checker = createStartupChecker(d);
    expect(await checker.run(defaultSettings.updateCheckOnStart, true)).toBeNull();
    expect(d.check).not.toHaveBeenCalled();
    expect(d.info).not.toHaveBeenCalled();
  });
  it("is off by default and in every unusable settings value", () => {
    expect(defaultSettings.updateCheckOnStart).toBe(false);
    expect(normalizeSettings(null).updateCheckOnStart).toBe(false);
    expect(normalizeSettings({ updateCheckOnStart: "ja" }).updateCheckOnStart).toBe(false);
    expect(normalizeSettings({ updateCheckOnStart: 1 }).updateCheckOnStart).toBe(false);
    expect(normalizeSettings({ updateCheckOnStart: true }).updateCheckOnStart).toBe(true);
  });
  it("is a shared setting (written to settings.json)", () => {
    expect(JSON.parse(serializeSettings({ ...defaultSettings, updateCheckOnStart: true }))).toMatchObject({ updateCheckOnStart: true });
  });
  it("follows only the loaded settings file: no loaded file (cache only) never checks", async () => {
    expect(startCheckEnabled(null)).toBe(false);
    expect(startCheckEnabled(undefined)).toBe(false);
    expect(startCheckEnabled({ updateCheckOnStart: false })).toBe(false);
    expect(startCheckEnabled({ updateCheckOnStart: true })).toBe(true);
    // the cache says true, the load failed: the value handed to the checker is false -> no update_check
    const d = deps();
    expect(await createStartupChecker(d).run(startCheckEnabled(null), true)).toBeNull();
    expect(d.check).not.toHaveBeenCalled();
  });
  it("does not check before the app is ready", async () => {
    const d = deps();
    const checker = createStartupChecker(d);
    expect(await checker.run(true, false)).toBeNull();
    expect(d.check).not.toHaveBeenCalled();
  });
  it("setting on: checks once and returns the available update", async () => {
    const d = deps();
    const checker = createStartupChecker(d);
    expect(await checker.run(true, true)).toMatchObject({ version: "0.4.0" });
    expect(await checker.run(true, true)).toBeNull();
    expect(d.check).toHaveBeenCalledTimes(1);
  });
  it("decides once per run: switching on later does not check before the next start", async () => {
    const d = deps();
    const checker = createStartupChecker(d);
    await checker.run(false, true);
    expect(await checker.run(true, true)).toBeNull();
    expect(d.check).not.toHaveBeenCalled();
  });
  it("does not check in a build without update configuration", async () => {
    const d = deps({ info: async () => info({ configured: false }) });
    expect(await createStartupChecker(d).run(true, true)).toBeNull();
    expect(d.check).not.toHaveBeenCalled();
  });
  it("discards errors silently and reports nothing when up to date", async () => {
    expect(await createStartupChecker(deps({ check: async () => { throw "Keine Verbindung"; } })).run(true, true)).toBeNull();
    expect(await createStartupChecker(deps({ info: async () => { throw "kaputt"; } })).run(true, true)).toBeNull();
    expect(await createStartupChecker(deps({ check: async () => ({ available: false, version: null, notes: null, pubDate: null }) })).run(true, true)).toBeNull();
  });
  it("describes the setting without promising more than it does", () => {
    expect(updateStartNote()).toBe("Fragt beim Start einmal pkg.werklade.de ab. Es werden keine Daten übertragen.");
  });
});

describe("Help menu", () => {
  const help = (updateVersion?: string | null) => createMenus({ savedSessions: [], settings: defaultSettings, hasWsl: false, activeId: 1, multiExec: false, isLinux: true, updateVersion }).find(menu => menu.id === "help")!.items;
  it("offers the update check", () => {
    expect(help().map(item => item.action)).toEqual(["shortcuts", "updates", "about"]);
    expect(help()[1].label).toBe("Nach Updates suchen…");
  });
  it("marks an available update in the entry", () => {
    expect(help("0.4.0")[1].label).toBe("Nach Updates suchen… (Version 0.4.0 verfügbar)");
  });
});
