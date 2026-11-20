import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { UpdateDialogView, aptNote, cancelBlockedNote, downloadNote, notConfiguredNote, updateRestartNote, windowsRestartNote, adminNote, type UpdateDialogViewProps } from "./UpdateDialogView";
import { aptCommand, aptRepoNote, blockedFallback, initialUpdateState, notesMaxChars, updateDownloadUrl, updateReducer, type UpdateCheck, type UpdateEvent, type UpdateInfo, type UpdateState } from "../lib/updateState";

// Same approach as DataDirForm.test.tsx: only the hooks are replaced, the JSX is real.
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), useId: () => "test-update", useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));
vi.mock("./useModal", () => ({ useModal: () => ({ current: null }) }));

type Element = ReactElement<Record<string, unknown>>;
function findAll(node: ReactNode, predicate: (element: Element) => boolean, found: Element[] = []): Element[] {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (predicate(child)) found.push(child);
    findAll(child.props.children as ReactNode, predicate, found);
  }
  return found;
}
function textOf(node: ReactNode): string {
  return Children.toArray(node).map(child => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    return isValidElement<Record<string, unknown>>(child) ? textOf(child.props.children as ReactNode) : "";
  }).join("");
}
const buttons = (tree: ReactNode) => findAll(tree, e => e.type === "button");
const button = (tree: ReactNode, label: string) => buttons(tree).find(e => textOf(e.props.children as ReactNode) === label);
const labels = (tree: ReactNode) => buttons(tree).map(e => textOf(e.props.children as ReactNode));
const primaries = (tree: ReactNode) => buttons(tree).filter(e => e.props.type === "submit").map(e => textOf(e.props.children as ReactNode));
const alerts = (tree: ReactNode) => findAll(tree, e => e.props.role === "alert").map(e => textOf(e));

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({ currentVersion: "0.3.0", installKind: "appimage", selfUpdate: true, channel: "stable", configured: true, canInstall: true, blockedReason: null, ...over });
const check = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({ available: true, version: "0.4.0", notes: "Neu: Update-Prüfung\nBehoben: Absturz", pubDate: "2026-11-10T12:00:00Z", ...over });
const run = (events: UpdateEvent[], from: UpdateState = initialUpdateState): UpdateState => events.reduce(updateReducer, from);
const offer = (i: Partial<UpdateInfo> = {}, c: Partial<UpdateCheck> = {}) => run([{ type: "info", info: info(i) }, { type: "checked", check: check(c) }]);

const handlers = { onClose: vi.fn(), onInstall: vi.fn(), onRetry: vi.fn(), onCopy: vi.fn() };
const render = (state: UpdateState, over: Partial<UpdateDialogViewProps> = {}) => UpdateDialogView({ state, copyNote: "", copyFailed: false, ...handlers, ...over });
const cancel = (tree: ReactNode) => {
  const preventDefault = vi.fn();
  (findAll(tree, e => e.type === "dialog")[0].props.onCancel as (event: { preventDefault(): void }) => void)({ preventDefault });
  return preventDefault;
};
beforeEach(() => vi.clearAllMocks());

describe("checking", () => {
  it("announces the search and offers Abbrechen, which closes", () => {
    const tree = render(initialUpdateState);
    expect(textOf(tree)).toContain("Suche nach Updates…");
    expect(findAll(tree, e => e.props.role === "status").length).toBeGreaterThan(0);
    expect(labels(tree)).toEqual(["Abbrechen"]);
    (button(tree, "Abbrechen")!.props.onClick as () => void)();
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(primaries(tree)).toEqual([]);
  });
  it("closes on Esc while checking", () => {
    const state = run([{ type: "info", info: info() }]);
    expect(state.phase).toBe("checking");
    cancel(render(state));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("up to date and not configured", () => {
  it("shows the current version", () => {
    const tree = render(run([{ type: "info", info: info() }, { type: "checked", check: { available: false, version: null, notes: null, pubDate: null } }]));
    expect(textOf(tree)).toContain("Werkterm ist aktuell (Version 0.3.0)");
    expect(labels(tree)).toEqual(["Schließen"]);
    expect(primaries(tree)).toEqual([]);
  });
  it("says the build has no update check and offers nothing else", () => {
    const tree = render(run([{ type: "info", info: info({ configured: false }) }]));
    expect(notConfiguredNote()).toBe("Update-Prüfung ist in diesem Build nicht eingerichtet.");
    expect(textOf(tree)).toContain(notConfiguredNote());
    expect(labels(tree)).toEqual(["Schließen"]);
  });
});

describe("update available", () => {
  it("self-update: version, local date, notes as plain text, one primary button and the restart note", () => {
    const tree = render(offer());
    const text = textOf(tree);
    expect(text).toContain("Version 0.4.0 ist verfügbar");
    expect(text).toMatch(/Veröffentlicht am \d{2}[./]\d{2}[./]\d{4}|Veröffentlicht am .*2026/);
    expect(text).toContain(updateRestartNote());
    expect(updateRestartNote()).toBe("Werkterm startet danach neu. Offene Verbindungen werden getrennt.");
    expect(labels(tree)).toEqual(["Schließen", "Herunterladen und installieren"]);
    expect(primaries(tree)).toEqual(["Herunterladen und installieren"]);
    (button(tree, "Herunterladen und installieren")!.props.onClick as () => void)();
    expect(handlers.onInstall).toHaveBeenCalledTimes(1);
    const notes = findAll(tree, e => e.props.className === "update-notes")[0];
    expect(notes.type).toBe("div");
    expect(textOf(notes)).toBe("Neu: Update-Prüfung Behoben: Absturz");
    expect(notes.props.tabIndex).toBe(0);
    expect(notes.props["aria-labelledby"]).toBe("update-notes-title");
  });
  it("formats Markdown notes into headings, lists and inline code", () => {
    const tree = render(offer({}, { notes: "### Added\n\n- Foo `bar` **baz**\n- Qux" }));
    const notes = findAll(tree, e => e.props.className === "update-notes")[0];
    expect(textOf(findAll(notes, e => e.type === "h4")[0])).toBe("Added");
    expect(findAll(notes, e => e.type === "li")).toHaveLength(2);
    expect(textOf(findAll(notes, e => e.type === "code")[0])).toBe("bar");
    expect(textOf(findAll(notes, e => e.type === "strong")[0])).toBe("baz");
    expect(findAll(notes, e => e.type === "a")).toHaveLength(0);
  });
  it("renders server notes as text children, never as markup", () => {
    const evil = "<img src=x onerror=alert(1)><script>alert(1)</script>";
    const tree = render(offer({}, { notes: evil }));
    const notes = findAll(tree, e => e.props.className === "update-notes")[0];
    expect(textOf(notes)).toBe(evil);
    expect(findAll(tree, e => e.props.dangerouslySetInnerHTML !== undefined)).toHaveLength(0);
    expect(findAll(tree, e => e.type === "img" || e.type === "script")).toHaveLength(0);
  });
  it("caps very long notes", () => {
    const tree = render(offer({}, { notes: "x".repeat(notesMaxChars * 5) }));
    expect(textOf(findAll(tree, e => e.props.className === "update-notes")[0]).length).toBeLessThanOrEqual(notesMaxChars + 2);
  });
  it("omits the notes block and the date when the server sends none", () => {
    const tree = render(offer({}, { notes: null, pubDate: null }));
    expect(findAll(tree, e => e.props.className === "update-notes")).toHaveLength(0);
    expect(textOf(tree)).not.toContain("Veröffentlicht");
  });
  it("restart note per platform: Linux restarts, NSIS quits and restarts, MSI also asks for admin rights", () => {
    const linux = textOf(render(offer({ installKind: "appimage" })));
    expect(linux).toContain(updateRestartNote());
    expect(linux).not.toContain(adminNote());
    const nsis = textOf(render(offer({ installKind: "nsis" })));
    expect(nsis).toContain(windowsRestartNote());
    expect(nsis).not.toContain(updateRestartNote());
    expect(nsis).not.toContain(adminNote());
    const msi = textOf(render(offer({ installKind: "msi" })));
    expect(msi).toContain(windowsRestartNote());
    expect(msi).toContain(adminNote());
  });
  it("announced version without 'available' never produces an offer", () => {
    const tree = render(run([{ type: "info", info: info() }, { type: "checked", check: check({ available: false }) }]));
    expect(textOf(tree)).toContain("Werkterm ist aktuell (Version 0.3.0)");
    expect(findAll(tree, e => e.props.className === "update-notes")).toHaveLength(0);
  });
  it("deb: no install button, apt note and the command in a copyable field", () => {
    const tree = render(offer({ selfUpdate: false, installKind: "deb" }));
    expect(textOf(tree)).toContain(aptNote());
    expect(aptNote()).toBe("Diese Installation wird über die Paketverwaltung aktualisiert.");
    expect(textOf(findAll(tree, e => e.type === "code")[0])).toBe("sudo apt update && sudo apt install --only-upgrade werkterm");
    expect(textOf(tree)).toContain(aptRepoNote());
    expect(labels(tree)).toEqual(["Kopieren", "Schließen"]);
    expect(primaries(tree)).toEqual([]);
    expect(textOf(tree)).not.toContain(updateRestartNote());
    (button(tree, "Kopieren")!.props.onClick as () => void)();
    expect(handlers.onCopy).toHaveBeenCalledWith(aptCommand);
  });
  it("deb on the test channel: steps for the APT test distribution and a copyable one-liner", () => {
    const tree = render(offer({ selfUpdate: false, installKind: "deb", channel: "test" }, { version: "0.4.0" }));
    const text = textOf(tree);
    expect(text).toContain("Testversionen kommen aus der APT-Distribution „test“.");
    expect(text).toContain("In /etc/apt/sources.list.d/werklade.sources die Zeile setzen:");
    expect(text).not.toContain(aptNote());
    const codes = findAll(tree, e => e.type === "code").map(e => textOf(e));
    const command = "grep -q '^Suites:' /etc/apt/sources.list.d/werklade.sources && sudo sed -i 's/^Suites:.*$/Suites: stable test/' /etc/apt/sources.list.d/werklade.sources && sudo apt update && sudo apt install werkterm";
    expect(codes).toEqual(["Suites: stable test", "sudo apt update", "sudo apt install werkterm", command]);
    expect(labels(tree)).toEqual(["Kopieren", "Schließen"]);
    expect(primaries(tree)).toEqual([]);
    (button(tree, "Kopieren")!.props.onClick as () => void)();
    expect(handlers.onCopy).toHaveBeenCalledWith(command);
  });
  it("deb back to stable: warning without question, pinned stable version, no install button", () => {
    const tree = render(offer({ selfUpdate: false, installKind: "deb", currentVersion: "1.3.0", canInstall: false }, { version: "1.2.0", downgrade: true }));
    const text = textOf(tree);
    expect(alerts(tree).join(" ")).toContain("Version 1.2.0 ist älter als die installierte Version 1.3.0.");
    expect(alerts(tree).join(" ")).not.toContain("zurückwechseln?");
    expect(text).toContain("apt fragt vor dem Downgrade nach einer Bestätigung.");
    expect(text).toContain("Installiert ist eine neuere Version als die stabile.");
    expect(text).toContain("„apt policy werkterm“ zeigt, welche stabile Version verfügbar ist.");
    const command = "grep -q '^Suites:' /etc/apt/sources.list.d/werklade.sources && sudo sed -i 's/^Suites:.*$/Suites: stable/' /etc/apt/sources.list.d/werklade.sources && sudo apt update && sudo apt install werkterm=1.2.0";
    expect(findAll(tree, e => e.type === "code").map(e => textOf(e))).toEqual(["Suites: stable", "sudo apt update", "sudo apt install werkterm=1.2.0", command]);
    expect(labels(tree)).toEqual(["Kopieren", "Schließen"]);
    expect(primaries(tree)).toEqual([]);
    (button(tree, "Kopieren")!.props.onClick as () => void)();
    expect(handlers.onCopy).toHaveBeenCalledWith(command);
  });
  it("deb back to stable with a non-SemVer offer: no command with that version", () => {
    const tree = render(offer({ selfUpdate: false, installKind: "deb", currentVersion: "1.3.0" }, { version: "1.2.0-x", downgrade: true }));
    expect(textOf(tree)).toContain("Die angebotene Versionsnummer ist ungültig.");
    expect(findAll(tree, e => e.type === "code").map(e => textOf(e))).toEqual(["Suites: stable", "sudo apt update"]);
    expect(labels(tree)).toEqual(["Schließen"]);
  });
  it("rpm keeps the generic apt-free hint", () => {
    const tree = render(offer({ selfUpdate: false, installKind: "rpm", channel: "test" }));
    expect(textOf(tree)).not.toContain("APT-Distribution");
    expect(textOf(findAll(tree, e => e.type === "code")[0])).toBe(updateDownloadUrl);
  });
  it("self-update blocked here: reason as note, download address to copy, no install button", () => {
    const tree = render(offer({ canInstall: false, blockedReason: "UPDATE_NOT_WRITABLE" }));
    expect(textOf(tree)).toContain("Der Ordner des AppImage ist nicht beschreibbar");
    expect(textOf(findAll(tree, e => e.type === "code")[0])).toBe(updateDownloadUrl);
    expect(labels(tree)).toEqual(["Kopieren", "Schließen"]);
    expect(primaries(tree)).toEqual([]);
    expect(textOf(tree)).not.toContain(updateRestartNote());
    (button(tree, "Kopieren")!.props.onClick as () => void)();
    expect(handlers.onCopy).toHaveBeenCalledWith(updateDownloadUrl);
  });
  it("blocked without a reason falls back to a general sentence", () => {
    expect(textOf(render(offer({ canInstall: false, blockedReason: null })))).toContain(blockedFallback());
  });
  it.each(["rpm", "other"] as const)("%s: download address as copyable text, no install button, nothing opens by itself", kind => {
    const tree = render(offer({ selfUpdate: false, installKind: kind }));
    expect(textOf(tree)).toContain(downloadNote());
    expect(textOf(findAll(tree, e => e.type === "code")[0])).toBe("https://pkg.werklade.de/werkterm/");
    expect(labels(tree)).toEqual(["Kopieren", "Schließen"]);
    expect(findAll(tree, e => e.type === "a")).toHaveLength(0);
    (button(tree, "Kopieren")!.props.onClick as () => void)();
    expect(handlers.onCopy).toHaveBeenCalledWith(updateDownloadUrl);
  });
  it("shows the copy result: success as status, failure as alert", () => {
    const base = offer({ selfUpdate: false, installKind: "deb" });
    const statuses = findAll(render(base, { copyNote: "Kopiert" }), e => e.props.role === "status").map(e => textOf(e));
    expect(statuses[statuses.length - 1]).toBe("Kopiert");
    expect(alerts(render(base, { copyNote: "Zwischenablage nicht verfügbar", copyFailed: true }))).toEqual(["Zwischenablage nicht verfügbar"]);
  });
  it("test channel: shows a quiet hint, stable does not", () => {
    expect(textOf(render(offer({ channel: "test" })))).toContain("Testkanal");
    expect(textOf(render(offer({ channel: "stable" })))).not.toContain("Testkanal");
  });
  it("puts the initial focus on the primary action, else on the close button", () => {
    const focused = (tree: ReactNode) => findAll(tree, e => e.props["data-initial-focus"] !== undefined).map(e => textOf(e.props.children as ReactNode));
    expect(focused(render(offer()))).toEqual(["Herunterladen und installieren"]);
    expect(focused(render(offer({ selfUpdate: false, installKind: "deb" })))).toEqual(["Schließen"]);
    expect(focused(render(initialUpdateState))).toEqual(["Abbrechen"]);
  });
});

describe("installing", () => {
  const installing = (progress?: { downloaded: number; total: number | null }) =>
    run(progress ? [{ type: "install" }, { type: "progress", progress }] : [{ type: "install" }], offer());
  const bar = (tree: ReactNode) => findAll(tree, e => e.props.role === "progressbar")[0];
  it("shows a determinate bar with aria values", () => {
    const tree = render(installing({ downloaded: 50, total: 200 }));
    expect(bar(tree).props).toMatchObject({ "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": 25, "aria-label": "Fortschritt der Installation" });
    const fill = findAll(bar(tree).props.children as ReactNode, e => typeof e.props.className === "string")[0];
    expect(fill.props.style).toEqual({ width: "25%" });
    expect(String(bar(tree).props["aria-valuetext"])).toContain("25 %");
  });
  it("is indeterminate without a total: no aria-valuenow", () => {
    const tree = render(installing({ downloaded: 1024, total: null }));
    expect(bar(tree).props["aria-valuenow"]).toBeUndefined();
    expect(findAll(bar(tree).props.children as ReactNode, e => String(e.props.className).includes("indeterminate"))).toHaveLength(1);
    expect(String(bar(tree).props["aria-valuetext"])).toBe("1,0 KB heruntergeladen");
  });
  it("blocks closing: disabled button, Esc ignored, reason stated, no primary button", () => {
    const tree = render(installing());
    expect(button(tree, "Schließen")!.props.disabled).toBe(true);
    expect(cancel(tree)).toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(textOf(tree)).toContain(cancelBlockedNote());
    expect(primaries(tree)).toEqual([]);
  });
  it("keeps the focus inside the dialog on the progress bar", () => {
    expect(findAll(render(installing()), e => e.props["data-initial-focus"] !== undefined).map(e => e.props.role)).toEqual(["progressbar"]);
  });
  it("also blocks closing while restarting", () => {
    const tree = render(run([{ type: "install" }, { type: "installed" }], offer()));
    expect(textOf(tree)).toContain("Werkterm wird neu gestartet…");
    expect(button(tree, "Schließen")!.props.disabled).toBe(true);
    cancel(tree);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });
});

describe("error", () => {
  it("shows the message as alert in the danger style, with one primary button", () => {
    const state = run([{ type: "info", info: info() }, { type: "failed", message: "Keine Verbindung zu pkg.werklade.de." }]);
    const tree = render(state);
    expect(alerts(tree)).toEqual(["Keine Verbindung zu pkg.werklade.de."]);
    expect(findAll(tree, e => e.props.role === "alert")[0].props.className).toBe("update-error");
    expect(labels(tree)).toEqual(["Schließen", "Erneut versuchen"]);
    expect(primaries(tree)).toEqual(["Erneut versuchen"]);
    (button(tree, "Erneut versuchen")!.props.onClick as () => void)();
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
  });
  it("a failed install can be closed and retried", () => {
    const tree = render(run([{ type: "install" }, { type: "failed", message: "Signatur ungültig" }], offer()));
    expect(alerts(tree)).toEqual(["Signatur ungültig"]);
    expect(button(tree, "Schließen")!.props.disabled).toBe(false);
    cancel(tree);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
  it("works when update_info itself failed", () => {
    const tree = render(run([{ type: "failed", message: "Befehl fehlt" }]));
    expect(alerts(tree)).toEqual(["Befehl fehlt"]);
    expect(labels(tree)).toEqual(["Schließen", "Erneut versuchen"]);
  });
});

describe("dialog basics and wording", () => {
  it("is a labelled modal dialog", () => {
    const dialog = findAll(render(offer()), e => e.type === "dialog")[0];
    expect(dialog.props["aria-modal"]).toBe("true");
    expect(dialog.props["aria-labelledby"]).toBe("test-update");
    expect(dialog.props.className).toBe("ssh-dialog update-dialog");
  });
  it("avoids 'bitte' and exclamation marks in every state", () => {
    const states = [
      initialUpdateState, offer(), offer({ selfUpdate: false, installKind: "deb" }), offer({ selfUpdate: false, installKind: "rpm" }), offer({ installKind: "nsis", channel: "test" }),
      run([{ type: "info", info: info({ configured: false }) }]),
      run([{ type: "install" }], offer()), run([{ type: "install" }, { type: "installed" }], offer()), run([{ type: "failed", message: "Fehler" }]),
    ];
    for (const state of states) expect(textOf(render(state))).not.toMatch(/bitte|!/i);
  });
  it("has at most one primary button in every state", () => {
    const states = [initialUpdateState, offer(), offer({ selfUpdate: false, installKind: "deb" }), run([{ type: "install" }], offer()), run([{ type: "failed", message: "x" }])];
    for (const state of states) expect(primaries(render(state)).length).toBeLessThanOrEqual(1);
  });
});

describe("downgrade back to stable", () => {
  const downgrade = () => offer({ currentVersion: "1.2.0" }, { version: "1.1.0", downgrade: true });
  it("warns with both versions and makes the only primary button the explicit confirmation", () => {
    const tree = render(downgrade());
    const text = textOf(tree);
    expect(text).toContain("Stable-Version 1.1.0 ist verfügbar");
    expect(alerts(tree)).toEqual(["Version 1.1.0 ist älter als die installierte Version 1.2.0. Einstellungen, die es nur in der neueren Version gibt, können verloren gehen. Auf Stable zurückwechseln?"]);
    expect(primaries(tree)).toEqual(["Auf Stable zurückwechseln"]);
    expect(labels(tree)).not.toContain("Herunterladen und installieren");
    (button(tree, "Auf Stable zurückwechseln")!.props.onClick as () => void)();
    expect(handlers.onInstall).toHaveBeenCalledTimes(1);
  });
  it("shows no warning for a normal update", () => {
    const tree = render(offer());
    expect(alerts(tree)).toEqual([]);
    expect(primaries(tree)).toEqual(["Herunterladen und installieren"]);
  });
});

describe("only one manifest checked", () => {
  it("does not claim up to date without saying which manifest was skipped", () => {
    const tree = render(run([{ type: "info", info: info({ channel: "test" }) }, { type: "checked", check: { available: false, version: "0.3.0", notes: null, pubDate: null, skippedManifest: "test", partialError: "UPDATE_TIMEOUT" } }]));
    expect(textOf(tree)).toContain("Werkterm ist aktuell");
    expect(alerts(tree)).toHaveLength(1);
    expect(alerts(tree)[0]).toContain("Testkanal nicht erreichbar, nur Stable geprüft.");
  });
  it("shows the hint with an offer when stable failed", () => {
    const text = textOf(render(offer({ channel: "test" }, { skippedManifest: "stable", partialError: "UPDATE_UNREACHABLE" })));
    expect(text).toContain("Stable nicht erreichbar, nur Testkanal geprüft.");
  });
  it("shows no hint when both manifests were read", () => {
    expect(textOf(render(offer({ channel: "test" })))).not.toContain("nicht erreichbar, nur");
  });
  it("warns that settings of the newer version may be lost on a downgrade", () => {
    expect(alerts(render(offer({ currentVersion: "1.2.0" }, { version: "1.1.0", downgrade: true }))).join(" ")).toContain("Einstellungen, die es nur in der neueren Version gibt, können verloren gehen.");
  });
});
