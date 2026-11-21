import { activateIconSet, reloadIconSet } from "./lib/iconSets";
import { errorCode, errorText } from "./lib/backendError";
import { applyDesign, getDesign, getUserDesigns, registerUserDesign, syncUserDesigns, designWritesPending, designsChangedEvent, type StoredDesign } from "./lib/designs";
import { SerialPermissionDialog } from "./components/SerialPermissionDialog";
import { serialFixCommands, type SerialPermission } from "./lib/serialPermission";
import { FolderDiffView } from "./components/FolderDiffView";
import { backendSource, type FolderPair, type FolderOptions } from "./lib/folderDiff";
import { clampPanel, DEFAULT_PANEL_WIDTH, loadWidth, storeWidth } from "./lib/browserWidths";
import { useMacros } from "./components/Macros";
import { DiffDialog } from "./components/DiffDialog";
import { comparisonSources, rememberedSource, diffTitle, fileName, diffError, loadDiffPair, type DiffSource, type DiffPair } from "./lib/diff";
import { connectionTitle, connectionStatus } from "./lib/connection";
import { defaultSerial } from "./lib/sessions";
import { tuxTestEvent } from "./components/TuxOverlay";
import { TunnelDialog, TunnelConfirmDialog } from "./components/TunnelDialog";
import { isLoopback, type Tunnel, type TunnelStatus } from "./lib/tunnels";
import { listen } from "@tauri-apps/api/event";
import { SshCloseDialog } from "./components/SshCloseDialog";
import { activeSshTabs, shouldConfirmSsh, closeAfterSsh } from "./lib/sshClose";
import { shouldFocusMenu } from "./lib/menu";
import { SplitLayout, paneStyle, useSplitRatios } from "./components/SplitLayout";
import { assignPane, cleanPanes, paneCount, seedPanes, type SplitMode } from "./lib/split";
import { ToolDialog } from "./components/ToolDialog";
import { Home } from "./components/Home";
import { createMenus } from "./lib/actions";
import { resolveLanguage, setLanguage, t, tp, useLanguage, useT } from "./i18n";
import { recentList, lastTabsList, terminalDescriptors, type Recent, type LastTab } from "./lib/history";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SettingsDialog } from "./components/SettingsDialog";
import { HelpDialog } from "./components/HelpDialog";
import { UpdateDialog } from "./components/UpdateDialog";
import { UpdateTransfersDialog } from "./components/UpdateTransfersDialog";
import { updateCheck, updateInfo, updateInstall } from "./lib/update";
import { createStartupChecker, isRestartRequired, markerVersion, startCheckEnabled, withStoppedNote, type InstallRequest, type UpdateProgress } from "./lib/updateState";
import { chooseSessionExport } from "./lib/sessionExport";
import { WerktermImportDialog } from "./components/WerktermImportDialog";
import { ImportDialog } from "./components/ImportDialog";
import { normalizeSettings } from "./lib/settings";
import { MenuBar } from "./components/MenuBar";
import { Toolbar } from "./components/Toolbar";
import { Sidebar, type BrowserTab } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { SecretDialog } from "./components/SecretDialog";
import { SessionDialog } from "./components/SessionDialog";
import { QuickConnect } from "./components/QuickConnect";
import { SessionUserDialog } from "./components/SessionUserDialog";
import { jumpHostHint, listSessionFolders, listSessions, sessionTarget, type SavedSession } from "./lib/sessions";
import { createUndoSlot, type UndoEntry } from "./lib/undoOffer";
import { availableShells, type ShellKind } from "./lib/pty";
import { answerHostKey, answerSecret, type SshPrompt } from "./lib/ssh";
import { loadSettings, saveSettings, type Settings } from "./lib/settings";
import { revertedUiScale, uiScaler } from "./lib/uiScale";
import { SettingsSync, fileSettingsIo, setMigrateFlag, takeMigrateFlag } from "./lib/settingsSync";
import { appRestart, dataDirFingerprint, dataDirResetPointer, dataDirSet, dataDirStatus, mergeEntry, planReload, shouldCheck, type DataDirChoice, type DataDirStatus, type FileFingerprint } from "./lib/dataDir";
import { runSwitch } from "./lib/dataDirSwitch";
import { DataDirDialog, pickDataDir } from "./components/DataDirDialog";
import { DataDirErrorDialog, RestartDialog, resetPointerNotice } from "./components/DataDirForm";
import { parseQuickConnect, withQuickConnectUser } from "./lib/quickConnect";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { beginClose, advanceClose, type CloseAnswer } from "./lib/editorClose";
import { invoke, Channel } from "@tauri-apps/api/core";
import { allocateTransferId, cancelTransfer, downloadFile, ensureLocalDir, ensureRemoteDir, listLocalTree, listRemoteTree, uploadFile, type TransferProgress } from "./lib/transfers";
import { sep } from "@tauri-apps/api/path";
import { TransferQueue, type QueueState, type ConflictResolution } from "./lib/transferQueue";
import { FileActionDialog, type FileDialog } from "./components/FileActionDialog";
import type { EditorDocument } from "./lib/editorTypes";
import type { EditorHandle } from "./components/EditorView";
import { parentPath } from "./lib/paths";
import { browserForEditor, editorFileKey, sourceForEditorOpen } from "./lib/tabSources";
import { useModal } from "./components/useModal";
import "./styles/theme.css";
import "./App.css";
import { PasteDialog } from "./components/PasteDialog";
import { applyPasteChoice, pruneDeleted, rememberChoice, rememberedForSession, resetRememberedSession, resolveRemembered, shouldConfirmPaste, type PasteChoice } from "./lib/paste";
import { defaultLogFolder, openLogFolder, startLog, stopLog, terminalPasteRequests } from "./lib/sessionLog";
import { gridColumns, inputTargets, terminalWriters } from "./lib/multiExec";

const TerminalView = lazy(() => import("./components/TerminalView").then(module => ({ default: module.TerminalView })));

const DiffView = lazy(() => import("./components/DiffView"));
const EditorView = lazy(() => import("./components/EditorView"));
interface EditorTabState { document: EditorDocument; source: BrowserTab; sourceKey: string; dirty: boolean; status: string }
function EditorCloseDialog({ name, busy, onAnswer }: { name: string; busy: boolean; onAnswer: (answer: "save" | "discard" | "cancel") => void }) {
  const t = useT();
  const modal = useModal();
  useEffect(() => {
    if (!busy) modal.current?.querySelector<HTMLButtonElement>("[autofocus]")?.focus();
  }, [busy, modal]);
  return <dialog ref={modal} className="ssh-dialog" aria-modal="true" aria-labelledby="editor-close-title" onCancel={event => { event.preventDefault(); if (!busy) onAnswer("cancel"); }}>
    <h2 id="editor-close-title">{t("app.editorClose.title")}</h2><p>{t("app.editorClose.message", { name })}</p>
    <div className="dialog-actions"><button disabled={busy} onClick={() => onAnswer("save")}>{t("common.save")}</button><button disabled={busy} onClick={() => onAnswer("discard")}>{t("app.discard")}</button><button autoFocus disabled={busy} onClick={() => onAnswer("cancel")}>{t("common.cancel")}</button></div>
  </dialog>;
}
function editorOpenError(reason: unknown): string {
  switch (errorCode(reason)) {
    case "ENCODING": return t("app.openError.ENCODING");
    case "BINARY": return t("app.openError.BINARY");
    case "TOO_LARGE": return t("app.openError.TOO_LARGE");
    case "SESSION_CLOSED": return t("app.openError.SESSION_CLOSED");
    case "CONFLICT": return t("app.openError.CONFLICT");
    default: return t("app.openError.generic", { message: errorText(reason) });
  }
}

/** Title fields of a folder comparison tab; `titleKey` is resolved at render so it follows the language. */
const folderDiffTitle = (sources: [DiffSource, DiffSource]) => {
  const titleParams = { left: sources[0].path.split(/[\\/]/).pop() ?? "", right: sources[1].path.split(/[\\/]/).pop() ?? "" };
  return { title: t("app.folderDiff.title", titleParams), titleKey: "app.folderDiff.title" as const, titleParams };
};
interface QueuedPrompt { tabId: number; prompt: SshPrompt }
function localTitle() { return /Windows/i.test(navigator.userAgent) ? "PowerShell" : "Shell"; }
function declinePrompt(prompt: SshPrompt) {
  return prompt.type === "hostKey" ? answerHostKey(prompt.requestId, false) : answerSecret(prompt.requestId, null);
}

type DataPhase = "checking" | "setup" | "unreachable" | "error" | "ready";
/** Both plans end in the same sequence (prompts, flush, stop tunnels, last tabs, logs) and an app restart. */
type RestartPlan = { kind: "dataDir"; path: string | null; copy: boolean } | { kind: "update"; install(): Promise<void> };
export default function App() {
  // Start order: data_dir_status -> (setup | unreachable dialog) -> settings_load -> "ready" (sessions, macros, tunnels, designs load).
  const [dataPhase, setDataPhase] = useState<DataPhase>("checking");
  const dataReady = dataPhase === "ready";
  const dataReadyRef = useRef(false);
  dataReadyRef.current = dataReady;
  const [dataStatus, setDataStatus] = useState<DataDirStatus | null>(null);
  const [dataError, setDataError] = useState("");
  const [setupNotice, setSetupNotice] = useState("");
  // After data_dir_set every write path stays blocked; only the restart is offered (RestartDialog).
  const [restartRequired, setRestartRequired] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartError, setRestartError] = useState("");
  const [dataDirChange, setDataDirChange] = useState<{ status: DataDirStatus; choice: DataDirChoice } | null>(null);
  const [serialPermission, setSerialPermission] = useState<{ id: number; info: SerialPermission } | null>(null);
  const [tool, setTool] = useState<"ascii" | "ports" | "keygen" | null>(null);
  const [panes, setPanes] = useState<(number | null)[]>([]);
  const [focusedPane, setFocusedPane] = useState(0);
  const [ratios, setRatios] = useSplitRatios();
  const [multiExec, setMultiExec] = useState(false);
  const beforeMultiExec = useRef<number | null>(null);
  const [unchecked, setUnchecked] = useState<Set<number>>(() => new Set());
  const [pasteRequest, setPasteRequest] = useState<{ targets: number[]; data: string; multiExec: boolean; source: number } | null>(null);
  const [logPaths, setLogPaths] = useState<Record<number, string>>({});
  const logBusy = useRef(new Set<number>());
  const onLog = useCallback((id: number, path: string | null) => setLogPaths(current => { const next = { ...current }; if (path) next[id] = path; else delete next[id]; return next; }), []);
  useEffect(() => {
    const subscription = listen<{ id: number; message: string }>("session-log-error", event => {
      setStatus(errorText(event.payload.message)); onLog(event.payload.id, null);
    });
    return () => { void subscription.then(stop => stop()); };
  }, [onLog]);
  // useLanguage subscribes App, so the menus and tab titles built in this render pass follow a language switch.
  const language = useLanguage();
  // Stored tabs keep `titleKey` for built-in titles; `tabs` resolves them for the current language.
  const [storedTabs, setTabs] = useState<BrowserTab[]>([]);
  const tabs = useMemo(() => storedTabs.map(tab => tab.titleKey ? { ...tab, title: t(tab.titleKey, tab.titleParams) } : tab), [storedTabs, language]);
  const [folderDiffs, setFolderDiffs] = useState<Record<number, FolderPair>>({});
  const [diffs, setDiffs] = useState<Record<number, DiffPair>>({});
  const [diffDialog, setDiffDialog] = useState(false);
  const [marked, setMarked] = useState<DiffSource | null>(null);
  const markedSource = rememberedSource(marked, tabs);
  useEffect(() => { if (marked && !rememberedSource(marked, tabs)) setMarked(null); }, [marked, tabs]);
  const [editors, setEditors] = useState<Record<number, EditorTabState>>({});
  const editorsRef = useRef(editors);
  editorsRef.current = editors;
  const editorHandles = useRef(new Map<number, EditorHandle>());
  const pendingOpens = useRef(new Map<string, Promise<void>>());
  const closing = useRef(new Set<number>());
  const windowClosing = useRef(false);
  const closeAnswer = useRef<((answer: CloseAnswer) => void) | null>(null);
  /** Resolves true once the window was destroyed or the app restarted, false when the user cancelled a prompt. */
  const closeRequest = useRef<(restart?: RestartPlan) => Promise<boolean>>(async () => false);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(event => {
      // Prevent synchronously; destruction is requested only after the sequence succeeds.
      event.preventDefault();
      void closeRequest.current();
    }).then(stop => { if (disposed) stop(); else unlisten = stop; })
      .catch(reason => setStatus(errorText(reason)));
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const [sshClose, setSshClose] = useState<{ message: string; transfers: number; quitting: boolean; answer(accepted: boolean, never: boolean): void } | null>(null);
  const [closeEditorId, setCloseEditorId] = useState<number | null>(null);
  const [closeEditorBusy, setCloseEditorBusy] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(0);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [hasWsl, setHasWsl] = useState(false);
  const [shellsLoaded, setShellsLoaded] = useState(false);
  const [transfer, setTransfer] = useState<QueueState>(null);
  const [tunnelConfirmation, setTunnelConfirmation] = useState<((accepted: boolean) => void) | null>(null);
  const [tunnelsOpen, setTunnelsOpen] = useState(false);
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [tunnelStatuses, setTunnelStatuses] = useState<TunnelStatus[]>([]);
  const tunnelAutostart = useRef(false);
  const activeTunnels = tunnelStatuses.filter(s => ["running", "connecting", "reconnecting"].includes(s.state)).length;
  const reloadTunnels = async () => { setTunnels(await invoke<Tunnel[]>("tunnels_list")); setTunnelStatuses(await invoke<TunnelStatus[]>("tunnel_list_status")); };
  const tunnelPromptChannel = () => { const channel = new Channel<SshPrompt>(); channel.onmessage = prompt => queuePrompt(-1, prompt); return channel; };
  const startTunnel = async (t: Tunnel) => {
    const allowPublic = !isLoopback(t.bind_address) ? await new Promise<boolean>(resolve => setTunnelConfirmation(() => resolve)) : false;
    if (!isLoopback(t.bind_address) && !allowPublic) return;
    await invoke("tunnel_start", { id: t.id, allowPublic, onPrompt: tunnelPromptChannel() });
  };
  useEffect(() => {
    if (!dataReady) return;
    let disposed = false;
    const subscription = listen<TunnelStatus>("tunnel-status", event => { if (!disposed) setTunnelStatuses(current => [...current.filter(s => s.id !== event.payload.id), event.payload]); });
    void subscription.then(async () => {
      if (disposed) return;
      await reloadTunnels();
      if (!tunnelAutostart.current) { tunnelAutostart.current = true; await invoke("tunnel_autostart", { onPrompt: tunnelPromptChannel() }); }
    }).catch(reason => setStatus(errorText(reason)));
    return () => { disposed = true; void subscription.then(unlisten => unlisten()); };
  }, [dataReady]);
  // Empty means "ready": the default text is translated at render time, so it follows the language.
  const [status, setStatus] = useState("");
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [sessionDialog, setSessionDialog] = useState<{ session?: SavedSession; tabId?: number; preferPassword?: boolean } | null>(null);
  const [userSession, setUserSession] = useState<SavedSession | null>(null);
  const [quickUserTarget, setQuickUserTarget] = useState<string | null>(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionFolders, setSessionFolders] = useState<string[]>([]);
  const reloadSessions = useCallback(() => { void Promise.all([listSessions(), listSessionFolders()]).then(([items, folders]) => { setSavedSessions(items); setSessionFolders(folders); setSessionsLoaded(true); }).catch(() => setStatus(t("app.status.sessionsLoadFailed"))); }, []);
  // One undo offer at a time in the status line (moves and renames in the sessions panel); the timer ends with the window.
  const [undoEntry, setUndoEntry] = useState<UndoEntry | null>(null);
  const [undoSlot] = useState(() => createUndoSlot(setUndoEntry));
  useEffect(() => () => undoSlot.dispose(), [undoSlot]);
  useEffect(() => { if (dataReady) reloadSessions(); }, [dataReady, reloadSessions]);
  // localStorage only seeds the first render; settings.json replaces it once loaded (see bootstrapData).
  const [settings, setSettings] = useState(loadSettings);
  // main.tsx applies the cached language before the first render; this follows later changes (settings.json load, dialog).
  useLayoutEffect(() => { setLanguage(resolveLanguage(settings.language)); }, [settings.language]);
  // Interface size (webview zoom): main.tsx applies the cached value before the first render; a size already set is not
  // requested again. On failure the setting returns to the size actually shown, so selection and display agree.
  useLayoutEffect(() => {
    const failed = settings.uiScale;
    void uiScaler.apply(failed).catch(reason => {
      setStatus(t("app.status.uiScale", { reason: errorText(reason) }));
      const back = revertedUiScale(failed, settingsRef.current.uiScale, uiScaler.applied());
      if (back !== null) changeSettings({ ...settingsRef.current, uiScale: back as Settings["uiScale"] });
    });
  }, [settings.uiScale]);
  const [fontResetToken, setFontResetToken] = useState(0);
  const fingerprint = useRef<FileFingerprint[] | null>(null);
  const [settingsSync] = useState(() => new SettingsSync(fileSettingsIo, message => setStatus(message), {
    // Own write: the stamp returned by settings_save becomes the baseline, so it does not count as an external change.
    onSaved: stamp => { fingerprint.current = mergeEntry(fingerprint.current, [{ name: "settings.json", ...stamp }], "settings.json"); },
    // Conflict resolved by merging: show the merged result.
    onMerged: merged => { settingsRef.current = merged; setSettings(merged); setStatus(t("app.status.settingsMerged")); },
  }));
  const [designRevision, setDesignRevision] = useState(0);
  useEffect(() => {
    const changed = () => { setDesignRevision(value => value + 1); setSettings(value => ({ ...value })); };
    window.addEventListener(designsChangedEvent, changed);
    if (dataReady) void invoke<StoredDesign[]>("designs_list").then(rows => rows.forEach(row => {
      if (!getUserDesigns().some(stored => stored.id === row.id)) registerUserDesign(row.id, row.design);
    })).catch(() => setStatus(t("app.status.designsLoadFailed")));
    return () => window.removeEventListener(designsChangedEvent, changed);
  }, [dataReady]);
  useEffect(() => {
    if (!dataReady) return;
    // Derived value, device-local: updates state and cache only and never writes settings.json.
    void defaultLogFolder().then(logFolder => {
      if (!settingsRef.current.logFolder) { const next = normalizeSettings({ ...settingsRef.current, logFolder }); settingsRef.current = next; setSettings(next); saveSettings(next); }
    }).catch(reason => setStatus(t("app.status.logFolder", { reason: errorText(reason) })));
  }, [dataReady]);
  const applyLoadedSettings = (loaded: Settings) => { settingsRef.current = loaded; setSettings(loaded); };
  /** Own write of sessions.json (sessions panel): reload and take the new file state as baseline, so the focus check does not report it as external. */
  const sessionsWritten = () => {
    reloadSessions();
    void dataDirFingerprint().then(fresh => { fingerprint.current = mergeEntry(fingerprint.current, fresh, "sessions.json"); }).catch(() => undefined);
  };
  const refreshFingerprint = async () => { try { fingerprint.current = await dataDirFingerprint(); } catch { fingerprint.current = null; } };
  /** Status -> dialog (setup / unreachable) -> settings_load -> ready. Re-entered after a dialog choice. */
  const startCheckAllowed = useRef(false);
  const bootstrapData = async (firstSetup = false): Promise<boolean> => {
    let next: DataDirStatus;
    try { next = await dataDirStatus(); }
    catch (reason) { settingsSync.block(); setDataError(errorText(reason)); setDataPhase("error"); return false; }
    setDataError("");
    setDataStatus(next);
    if (!next.configured) { settingsSync.block(); setDataPhase("setup"); return false; }
    if (!next.reachable) { settingsSync.block(); setDataPhase("unreachable"); return false; }
    // localStorage is migrated into a missing settings.json only on first setup with the default folder or after
    // the user chose to copy the old data (marker set before the restart). Otherwise defaults apply.
    const migrate = takeMigrateFlag() || firstSetup;
    const loaded = await settingsSync.load({ migrate });
    if (loaded) applyLoadedSettings(loaded);
    // The start check follows only the settings that were really loaded; on a failed load (null) the cache must not decide.
    startCheckAllowed.current = startCheckEnabled(loaded);
    await refreshFingerprint();
    setDataPhase("ready");
    return true;
  };
  const bootstrapped = useRef(false);
  useEffect(() => { if (bootstrapped.current) return; bootstrapped.current = true; void bootstrapData(); }, []);
  /** Folder switched: block every write path, remember the copy choice for the next start, then restart. */
  const lockForSwitch = (copy: boolean) => {
    settingsSync.lock();
    setMigrateFlag(copy);
    setRestartRequired(true);
  };
  const finishSwitch = async (copy: boolean) => {
    lockForSwitch(copy);
    try { await appRestart(); } catch (reason) { setRestartError(errorText(reason)); }
  };
  const retryRestart = async () => {
    setRestartBusy(true); setRestartError("");
    try { await appRestart(); } catch (reason) { setRestartError(errorText(reason)); }
    finally { setRestartBusy(false); }
  };
  /** Startup dialogs: the default folder continues in place, any other folder needs a restart. */
  const applyStartupChoice = (firstSetup: boolean) => async (path: string | null, copy: boolean) => {
    await dataDirSet(path, copy);
    if (path === null) { setSetupNotice(""); setDataPhase("checking"); await bootstrapData(firstSetup); } else await finishSwitch(copy);
  };
  const retryDataDir = (): Promise<boolean> => bootstrapData();
  const [dataErrorBusy, setDataErrorBusy] = useState(false);
  const [dataErrorAction, setDataErrorAction] = useState("");
  const runDataErrorAction = async (action: () => Promise<void>) => {
    setDataErrorBusy(true); setDataErrorAction("");
    try { await action(); } catch (reason) { setDataErrorAction(errorText(reason)); }
    finally { setDataErrorBusy(false); }
  };
  const resetPointer = async () => {
    await dataDirResetPointer();
    setSetupNotice(resetPointerNotice);
    await bootstrapData();
  };
  const changeDataDirFrom = (current: DataDirStatus, choice: DataDirChoice) => setDataDirChange({ status: current, choice });
  const pickForChange = async (current: DataDirStatus) => {
    try { const path = await pickDataDir(); if (path !== null) changeDataDirFrom(current, { kind: "folder", path }); }
    catch (reason) { setStatus(t("app.status.folderPicker", { reason: errorText(reason) })); }
  };
  const sidebarVisible = settings.sidebarVisible;
  const setSidebarVisible = (value: boolean | ((current: boolean) => boolean)) => changeSettings({ ...settingsRef.current, sidebarVisible: typeof value === "function" ? value(settingsRef.current.sidebarVisible) : value });
  const [temporaryMenu, setTemporaryMenu] = useState(false);
  const [shellName, setShellName] = useState(localTitle);
  const [recents, setRecents] = useState<Recent[]>([]);
  const [lastTabs, setLastTabs] = useState<LastTab[]>([]);
  const [restoreQueue, setRestoreQueue] = useState<LastTab[] | null>(null);
  useEffect(() => {
    void invoke<string>("local_shell_name").then(setShellName).catch(reason => setStatus(errorText(reason)));
  }, []);
  useEffect(() => {
    if (!dataReady) return;
    void recentList().then(setRecents).catch(reason => setStatus(errorText(reason)));
    void lastTabsList().then(setLastTabs).catch(reason => setStatus(errorText(reason)));
  }, [dataReady]);
  useEffect(() => {
    const show = (event: KeyboardEvent) => {
      if (shouldFocusMenu(event, !!(document.activeElement?.closest(".terminal-panel, .xterm, .editor-view, .cm-editor"))) && !document.querySelector("dialog[open]")) {
        setTemporaryMenu(true);
        requestAnimationFrame(() => document.querySelector<HTMLElement>('.menubar [data-top="0"]')?.focus());
      }
      if (event.key === "Escape") setTemporaryMenu(false);
    };
    const outside = (event: PointerEvent) => { if (!(event.target instanceof Element && event.target.closest(".menubar"))) setTemporaryMenu(false); };
    document.addEventListener("keydown", show, true);
    document.addEventListener("pointerdown", outside, true);
    return () => { document.removeEventListener("keydown", show, true); document.removeEventListener("pointerdown", outside, true); };
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(() => clampPanel(loadWidth("werkterm.sidebar.width", DEFAULT_PANEL_WIDTH), window.innerWidth));
  const resizeSidebar = (width: number) => { const next = clampPanel(width, window.innerWidth); setSidebarWidth(next); storeWidth("werkterm.sidebar.width", next); };
  useEffect(() => { const resize = () => setSidebarWidth(width => clampPanel(width, window.innerWidth)); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  const [sidebarPanel, setSidebarPanel] = useState(3);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => { try { return localStorage.getItem("werkterm.sidebar.collapsed") === "1"; } catch { return false; } });
  const collapseSidebar = (value: boolean) => { setSidebarCollapsed(value); try { localStorage.setItem("werkterm.sidebar.collapsed", value ? "1" : "0"); } catch { /* storage unavailable */ } };
  // Every switch to a tab other than Home shows the SSH browser for that tab.
  useEffect(() => {
    if (activeId !== null && activeId !== 0) setSidebarPanel(3);
  }, [activeId]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [help, setHelp] = useState<"about" | "shortcuts" | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  /** Version found by the check (start check or dialog); only shown as a marker, never as a pop-up. */
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [restartForUpdate, setRestartForUpdate] = useState(false);
  const [restartNotInstalled, setRestartNotInstalled] = useState(false);
  const [transfersPrompt, setTransfersPrompt] = useState<{ count: number; answer(accepted: boolean): void } | null>(null);
  // Opt-in start check: decided once, the first time the app is ready. With the setting off update_check is never called.
  // The channel is read when the check runs (after settings_load), not when the checker is created.
  const [startupUpdateCheck] = useState(() => createStartupChecker({ info: () => updateInfo(settingsRef.current.updateChannel), check: channel => updateCheck(channel) }));
  useEffect(() => {
    if (!dataReady) return;
    void startupUpdateCheck.run(startCheckAllowed.current, true).then(update => { if (update) setUpdateVersion(update.version); });
  }, [dataReady]);
  const [importSource, setImportSource] = useState<"mobaxterm" | "windterm" | "werkterm" | null>(null);
  const fullscreenPending = useRef(false);
  useEffect(() => { void activateIconSet(settings.iconSet).catch(reason => setStatus(errorText(reason))); }, [settings.iconSet]);
  useLayoutEffect(() => { applyDesign(getDesign(settings.design)); }, [settings, designRevision]);
  const [prompts, setPrompts] = useState<QueuedPrompt[]>([]);
  const promptQueue = useRef<QueuedPrompt[]>([]);
  const liveTabs = useRef(new Set<number>());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const nextId = useRef(1);
  const sessions = useRef(new Map<number, number>());
  const sshTabs = useRef(new Set<number>());
  const [conflict, setConflict] = useState<FileDialog | null>(null);
  const [conflictSequence, setConflictSequence] = useState(0);
  const [transferQueue] = useState(() => new TransferQueue({
    download: downloadFile,
    upload: uploadFile,
    listRemoteTree,
    listLocalTree,
    ensureRemoteDir,
    ensureLocalDir,
    localSeparator: sep,
    cancel: cancelTransfer,
    allocateId: allocateTransferId,
    createChannel: (update: (progress: TransferProgress) => void) => new Channel<TransferProgress>(update),
    report: setStatus,
    resolveConflict: (name: string, signal: AbortSignal) => new Promise<ConflictResolution>(resolve => {
      let answered = false;
      const finish = (answer: ConflictResolution) => {
        if (answered) return;
        answered = true;
        signal.removeEventListener("abort", abort);
        setConflict(null);
        resolve(answer);
      };
      const abort = () => finish("cancel");
      if (signal.aborted) { finish("cancel"); return; }
      signal.addEventListener("abort", abort, { once: true });
      setConflictSequence(value => value + 1);
      setConflict({ type: "conflict", name, answer: answer => finish(answer === "all" ? "overwriteAll" : answer) });
    }),
  }));
  useEffect(() => transferQueue.subscribe(setTransfer), [transferQueue]);
  useEffect(() => transferQueue.onFinished(event => {
    if (event.summary !== undefined) setStatus(event.summary);
    else if (event.cancelled) setStatus(t("app.status.transferCancelled"));
    else if (event.error === undefined) setStatus(event.kind === "upload" ? t("app.status.uploadDone") : t("app.status.downloadDone"));
  }), [transferQueue]);
  useEffect(() => () => {
    for (const sessionId of sessions.current.values()) transferQueue.cancelSession(sessionId);
  }, [transferQueue]);
  const cancelTabTransfers = useCallback((id: number) => {
    const sessionId = sessions.current.get(id);
    if (sessionId !== undefined) transferQueue.cancelSession(sessionId);
    sessions.current.delete(id);
    sshTabs.current.delete(id);
  }, [transferQueue]);

  useEffect(() => {
    let cancelled = false;
    void availableShells().then(shells => { if (!cancelled) { setHasWsl(shells.includes("wsl")); setShellsLoaded(true); } }).catch((error: unknown) => {
      if (!cancelled) setStatus(t("app.status.shellsLoadFailed", { reason: errorText(error) }));
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => () => {
    for (const item of promptQueue.current) void declinePrompt(item.prompt).catch(() => undefined);
    promptQueue.current = [];
  }, []);

  const removePrompts = useCallback((id: number) => {
    const removed = promptQueue.current.filter(item => item.tabId === id);
    promptQueue.current = promptQueue.current.filter(item => item.tabId !== id);
    setPrompts([...promptQueue.current]);
    for (const item of removed) void declinePrompt(item.prompt).catch(() => undefined);
  }, []);
  const openTab = (kind: ShellKind, startCommand?: import("./lib/pty").StartCommand) => {
    if (windowClosing.current) return;
    const id = nextId.current++;
    liveTabs.current.add(id);
    setTabs(current => [...current, { id, kind, startCommand, ...(startCommand ? { titleKey: ({ root: "app.tab.root", processes: "app.tab.processes", hardware: "app.tab.hardware" } as const)[startCommand] } : {}), title: kind === "wsl" ? "WSL" : shellName, exited: false, browserPath: "" }]);
    setActiveId(id);
  };
  const connect = (target: string) => {
    if (windowClosing.current) return;
    const parsed = parseQuickConnect(target);
    if (!parsed) return;
    if (!parsed.kind && !parsed.user) { setQuickUserTarget(target.trim()); return; }
    const id = nextId.current++;
    liveTabs.current.add(id);
    sshTabs.current.add(id);
    setTabs(current => [...current, { id, kind: parsed.kind ?? "ssh", serial: parsed.kind === "serial" ? { ...defaultSerial, device: parsed.host, baud: parsed.baud ?? 115200 } : undefined, target: target.trim(), title: connectionTitle(parsed.kind ?? "ssh", target, parsed.kind === "serial" ? { ...defaultSerial, device: parsed.host, baud: parsed.baud ?? 115200 } : undefined), exited: false, browserPath: "" }]);
    setActiveId(id);
    setStatus(t("app.status.connecting", { name: connectionTitle(parsed.kind ?? "ssh", target, parsed.kind === "serial" ? { ...defaultSerial, device: parsed.host, baud: parsed.baud ?? 115200 } : undefined) }));
  };
  const connectSaved = (session: SavedSession, userOverride?: string) => {
    if (windowClosing.current) return;
    if (session.kind === "ssh" && !session.user && !userOverride) { setUserSession(session); return; }
    const id = nextId.current++;
    liveTabs.current.add(id);
    sshTabs.current.add(id);
    setTabs(current => [...current, { id, kind: session.kind as "ssh" | "telnet" | "serial", serial: session.serial, target: sessionTarget(session, userOverride), savedSessionId: session.id, title: session.name, exited: false, browserPath: "" }]);
    setActiveId(id);
    setStatus(t("app.status.connecting", { name: session.name }));
  };
  useEffect(() => {
    if (restoreQueue === null || userSession || quickUserTarget || windowClosing.current) return;
    if (tabs.some(t => t.kind === "ssh" && !t.exited && t.sessionId === undefined)) return;
    if (!restoreQueue.length) { setRestoreQueue(null); return; }
    const [tab, ...remaining] = restoreQueue;
    setRestoreQueue(remaining);
    if (tab.type === "local" || tab.type === "wsl") { if (tab.type === "local" || hasWsl) openTab(tab.type); }
    else if (tab.type === "saved") { const session = savedSessions.find(s => s.id === tab.sessionId); if (session) connectSaved(session); }
    else if (tab.type === "quick") connect(tab.target);
  });
  const reportStatus = (message: string) => {
    setStatus(message);
    const id = activeIdRef.current;
    if (id !== null) setEditors(current => !current[id] ? current : { ...current, [id]: { ...current[id], status: message } });
  };
  const removeTab = (id: number) => {
    setFolderDiffs(current => { const next = { ...current }; delete next[id]; return next; });
    setDiffs(current => { const next = { ...current }; delete next[id]; return next; });
    cancelTabTransfers(id);
    liveTabs.current.delete(id);
    removePrompts(id);
    const currentTabs = tabsRef.current;
    const index = currentTabs.findIndex(tab => tab.id === id);
    if (currentTabs[index]?.kind === "ssh" && currentTabs[index]?.sessionId === undefined && !currentTabs[index]?.exited) setStatus(t("app.status.connectAborted"));
    if (activeIdRef.current === id) setActiveId(currentTabs[index + 1]?.id ?? currentTabs[index - 1]?.id ?? 0);
    setTabs(current => current.filter(tab => tab.id !== id));
  };
  const askEditorClose = (id: number): Promise<CloseAnswer> => {
    setActiveId(id); setCloseEditorId(id);
    return new Promise(resolve => { closeAnswer.current = resolve; });
  };
  const finishEditorClose = async (id: number) => {
    const editor = editorsRef.current[id];
    if (!editor) return;
    await invoke("editor_close", { docId: editor.document.docId });
    const next = { ...editorsRef.current }; delete next[id];
    editorsRef.current = next; setEditors(next);
    editorHandles.current.delete(id);
    removeTab(id);
  };
  const closeEditors = async (ids: number[], remove: boolean): Promise<boolean> => {
    let state = beginClose(ids);
    while (state.phase === "pending") {
      const id = state.remaining[0];
      const editor = editorsRef.current[id];
      const handle = editorHandles.current.get(id);
      if (!editor || !handle) throw new Error(t("app.error.editorNotReady"));
      // Hold the lock across the final dirty check, dialog, save and editor_close.
      await handle.lock();
      try {
        const answer = handle.isDirty() ? await askEditorClose(id) : "discard";
        setCloseEditorBusy(true);
        const saved = answer !== "save" || (await handle.save() && !handle.isDirty());
        state = advanceClose(state, answer, saved);
        if (state.phase === "cancelled") return false;
        if (remove) await finishEditorClose(id);
      } finally {
        handle.unlock();
        setCloseEditorBusy(false); setCloseEditorId(null); closeAnswer.current = null;
      }
    }
    return true;
  };
  const askSshClose = async (ids?: number[]): Promise<boolean> => {
    const candidates = tabsRef.current.filter(tab => !ids || ids.includes(tab.id));
    const tunnelCount = ids ? 0 : (await invoke<TunnelStatus[]>("tunnel_list_status").catch(() => tunnelStatuses)).filter(s => ["running", "connecting", "reconnecting"].includes(s.state)).length;
    if (!shouldConfirmSsh(candidates, settingsRef.current.confirmCloseSsh) && !(tunnelCount && settingsRef.current.confirmCloseSsh)) return true;
    const active = activeSshTabs(candidates);
    const transfers = active.reduce((count, tab) => count + (tab.kind === "ssh" ? transferQueue.countSession(tab.sessionId!) : 0), 0);
    const destination = active[0] ? connectionTitle(active[0].kind, active[0].target ?? "", active[0].serial) : t("app.ssh.destination");
    const message = ids ? t("app.ssh.closeOne", { destination }) : [active.length > 0 ? tp("app.ssh.closeAll.connections", active.length) : "", tunnelCount > 0 ? tp("app.ssh.closeAll.tunnels", tunnelCount) : "", t("app.ssh.closeAll.question")].filter(Boolean).join(" ");
    return new Promise(resolve => setSshClose({ message, transfers, quitting: !ids, answer: (accepted, never) => {
      if (never) changeSettings({ ...settingsRef.current, confirmCloseSsh: false });
      setSshClose(null); resolve(accepted);
    } }));
  };
  const closeTab = (id: number) => {
    if (id === 0 || windowClosing.current || closing.current.size) return;
    closing.current.add(id);
    void closeAfterSsh(() => askSshClose([id]), async () => {
      if (editorsRef.current[id]) return closeEditors([id], true);
      removeTab(id); return true;
    }).catch(reason => reportStatus(errorText(reason))).finally(() => closing.current.delete(id));
  };
  const answerEditorClose = (answer: CloseAnswer) => {
    if (closeEditorBusy) return;
    const resolve = closeAnswer.current;
    closeAnswer.current = null;
    resolve?.(answer);
  };
  // Quit and data folder switch share one sequence: SSH prompt, editor prompts, then destroy or (restart) switch + relaunch.
  closeRequest.current = async (restart?: RestartPlan) => {
    if (windowClosing.current || closing.current.size) return false;
    windowClosing.current = true;
    const locked: EditorHandle[] = [];
    let done = false;
    let tunnelsStopped = false;
    let logsStopped = false;
    try {
      const approved = await closeAfterSsh(() => askSshClose(), async () => {
        await Promise.all(pendingOpens.current.values());
        // Freeze every document so a clean tab cannot become dirty mid-sequence.
        for (const handle of [...editorHandles.current.values()]) { locked.push(handle); await handle.lock(); }
        return closeEditors(Object.keys(editorsRef.current).map(Number), false);
      });
      if (approved) {
        // Without a usable data folder (setup, unreachable) there is nowhere to store the last tabs; closing must still work.
        const saveLastTabs = async () => { if (dataReadyRef.current) await invoke("last_tabs_save", { tabs: terminalDescriptors(tabsRef.current) }); };
        const stopLogs = async () => {
          const terminalTabs = tabsRef.current.filter(tab => tab.kind !== "editor" && tab.kind !== "diff" && tab.kind !== "folderDiff");
          if (terminalTabs.some(tab => logPaths[tab.id])) logsStopped = true;
          await Promise.all(terminalTabs.map(tab => stopLog(tab.id)));
        };
        // Update only: running file transfers end with the restart, so ask before anything is stopped.
        if (restart?.kind === "update") {
          const running = transferQueue.count();
          if (running > 0 && !(await new Promise<boolean>(resolve => setTransfersPrompt({ count: running, answer: accepted => { setTransfersPrompt(null); resolve(accepted); } })))) return false;
        }
        if (restart) {
          await runSwitch({
            flushSettings: () => settingsSync.flush(),
            // Approved closing also stops tunnels; the backend refuses a folder switch while any runs.
            stopTunnels: async () => {
              const running = (await invoke<TunnelStatus[]>("tunnel_list_status")).filter(s => ["running", "connecting", "reconnecting"].includes(s.state));
              if (running.length) tunnelsStopped = true;
              await Promise.all(running.map(s => invoke("tunnel_stop", { id: s.id })));
            },
            saveLastTabs, stopLogs,
            // Point of no return: the data folder switch, or the update download and installation.
            setDataDir: async () => { if (restart.kind === "dataDir") await dataDirSet(restart.path, restart.copy); else await restart.install(); },
            // An update does not touch the data folder: writes stay possible, the restart dialog only appears if the restart fails.
            lock: () => { if (restart.kind === "dataDir") lockForSwitch(restart.copy); },
            restart: () => appRestart(),
            onRestartFailed: message => { if (restart.kind === "update") { setRestartForUpdate(true); setRestartRequired(true); setUpdateOpen(false); } setRestartError(message); },
          });
        } else {
          await settingsSync.flush();
          await saveLastTabs();
          await stopLogs();
          await getCurrentWindow().destroy();
        }
        done = true;
      }
    } catch (reason) {
      if (restart?.kind === "update" && isRestartRequired(reason)) {
        // Windows: the app was shut down but the installer did not start. No further work, only the restart dialog.
        settingsSync.lock(); setRestartForUpdate(true); setRestartNotInstalled(true); setRestartRequired(true); setUpdateOpen(false);
        return false;
      }
      if (restart?.kind === "update") throw new Error(withStoppedNote(errorText(reason), { tunnels: tunnelsStopped, logs: logsStopped }));
      if (restart) throw new Error(t("app.error.dataDirSwitch", { reason: errorText(reason) }));
      reportStatus(t("app.error.windowClose", { reason: errorText(reason) }));
    }
    finally { for (const handle of locked) handle.unlock(); windowClosing.current = false; }
    return done;
  };
  const openEditor = (browserSource: BrowserTab, path: string) => {
    if (windowClosing.current) return;
    const source = sourceForEditorOpen(browserSource, editorsRef.current[browserSource.id]?.source);
    if (["editor", "diff", "telnet", "serial"].includes(source.kind)) return;
    const sourceKey = editorFileKey(source, path);
    const existing = Object.entries(editorsRef.current).find(([, editor]) => editor.sourceKey === sourceKey);
    if (existing) { setActiveId(Number(existing[0])); return; }
    if (pendingOpens.current.has(sourceKey)) return;
    const pending = (async () => {
      try {
        const document = await (source.kind === "ssh"
          ? invoke<EditorDocument>("editor_open_remote", { id: source.sessionId, path })
          : invoke<EditorDocument>("editor_open_local", { path, wslDistro: source.kind === "wsl" ? source.cwd?.host ?? null : null }));
        const id = nextId.current++;
        const editor: EditorTabState = { document, source: { ...source, browserPath: parentPath(path) }, sourceKey, dirty: false, status: "" };
        editorsRef.current = { ...editorsRef.current, [id]: editor };
        setEditors(editorsRef.current);
        setTabs(current => [...current, { id, kind: "editor", title: document.name, browserPath: parentPath(path), exited: false }]);
        setActiveId(id);
      } catch (reason: unknown) { reportStatus(editorOpenError(reason)); }
      finally { pendingOpens.current.delete(sourceKey); }
    })();
    pendingOpens.current.set(sourceKey, pending);
  };
  const compareFiles = async (sources: [DiffSource, DiffSource], options: FolderOptions = { recursive: true, contents: false }) => {
    try {
      const kinds = await Promise.all(sources.map(source => invoke<string>("folder_diff_kind", { source: backendSource(source) })));
      if (kinds[0] !== kinds[1]) throw new Error(t("app.error.mixedCompare"));
      if (kinds[0] === "dir") {
        if (windowClosing.current) return;
        const id = nextId.current++;
        setFolderDiffs(current => ({ ...current, [id]: { sources, options } }));
        setTabs(current => [...current, { id, kind: "folderDiff", ...folderDiffTitle(sources), browserPath: "", exited: false }]);
        setActiveId(id); return;
      }
      if (kinds[0] !== "file") throw new Error(t("app.error.unsupportedCompare"));
      const pair = await loadDiffPair(sources);
      for (const source of sources) if (!rememberedSource(source, tabsRef.current)) throw "SESSION_CLOSED:";
      if (windowClosing.current) return;
      const id = nextId.current++;
      setDiffs(current => ({ ...current, [id]: pair }));
      setTabs(current => [...current, { id, kind: "diff", title: diffTitle(sources[0].path, sources[1].path), titleKey: "diff.title", titleParams: { left: fileName(sources[0].path), right: fileName(sources[1].path) }, browserPath: "", exited: false }]);
      setActiveId(id);
    } catch (reason) { throw diffError(reason); }
  };
  const compareBrowserFile = (source: DiffSource, remember: boolean) => {
    const original = sourceForEditorOpen(source.tab, editorsRef.current[source.tab.id]?.source);
    const next = { ...source, tab: original };
    if (remember) { setMarked(next); return; }
    const sources = comparisonSources(markedSource, next);
    if (sources) void compareFiles(sources).catch(reason => reportStatus(errorText(reason)));
  };
  // Restart a finished session in the same tab; the new generation remounts the terminal view.
  const restartTab = useCallback((id: number) => {
    if (windowClosing.current) return;
    setTabs(current => current.map(tab => {
      if (tab.id !== id || !tab.exited) return tab;
      liveTabs.current.add(id);
      if (tab.kind === "ssh" || tab.kind === "telnet" || tab.kind === "serial") sshTabs.current.add(id);
      return { ...tab, exited: false, sessionId: undefined, generation: (tab.generation ?? 0) + 1 };
    }));
    setStatus(t("app.status.restarting"));
  }, []);
  const markExited = useCallback((id: number) => {
    cancelTabTransfers(id);
    liveTabs.current.delete(id);
    removePrompts(id);
    setTabs(current => current.map(tab => tab.id === id ? { ...tab, exited: true, sessionId: undefined } : tab));
  }, [removePrompts, cancelTabTransfers]);
  const setSession = useCallback((id: number, sessionId: number | null) => {
    if (sessionId === null) cancelTabTransfers(id);
    else if (liveTabs.current.has(id) && sshTabs.current.has(id)) {
      const tab = tabsRef.current.find(t => t.id === id);
      if (tab?.kind === "ssh") sessions.current.set(id, sessionId);
      if (tab) {
        const at = Date.now();
        const item: Recent = tab.savedSessionId ? { kind: "saved", sessionId: tab.savedSessionId, name: tab.title, at } : { kind: "quick", target: tab.target ?? "", at };
        void invoke("recent_add", { item }).then(recentList).then(setRecents).catch(reason => setStatus(errorText(reason)));
      }
    }
    setTabs(current => current.map(tab => tab.id === id && !tab.exited ? { ...tab, sessionId: sessionId ?? undefined } : tab));
  }, [cancelTabTransfers]);
  const setCwd = useCallback((id: number, cwd: { host: string; path: string }) => {
    setTabs(current => current.map(tab => {
      if (tab.id !== id) return tab;
      const changed = tab.cwd?.path !== cwd.path || tab.cwd.host !== cwd.host;
      const follow = changed && (settingsRef.current.followTerminalFolder || (!tab.cwd && tab.browserPath === "" && tab.kind !== "ssh"));
      return { ...tab, cwd, browserPath: follow ? cwd.path : tab.browserPath };
    }));
  }, []);
  const setBrowserAccess = useCallback((id: number, sessionId: number, mode: "sftp" | "exec" | "local", sudo: boolean) => {
    setTabs(current => current.map(tab => tab.id === id && tab.sessionId === sessionId && !tab.exited
      ? { ...tab, browserAccess: { sessionId, mode, sudo } } : tab));
  }, []);
  const setPath = useCallback((id: number, browserPath: string) => {
    setTabs(current => current.map(tab => tab.id === id ? { ...tab, browserPath } : tab));
  }, []);
  const changeSettings = (input: Settings) => {
    const next = normalizeSettings(input);
    settingsRef.current = next;
    setSettings(next);
    settingsSync.schedule(next);
    if (next.followTerminalFolder && !settings.followTerminalFolder) {
      setTabs(current => current.map(tab => tab.cwd ? { ...tab, browserPath: tab.cwd.path } : tab));
    }
  };
  const queuePrompt = useCallback((tabId: number, prompt: SshPrompt) => {
    if (tabId !== -1 && !liveTabs.current.has(tabId)) {
      void declinePrompt(prompt).catch(() => undefined);
      return;
    }
    if (promptQueue.current.some(item => item.prompt.requestId === prompt.requestId)) return;
    promptQueue.current = [...promptQueue.current, { tabId, prompt }];
    setPrompts([...promptQueue.current]);
  }, []);
  const answer = (item: QueuedPrompt, value: boolean | string | null) => {
    if (promptQueue.current[0] !== item) return;
    promptQueue.current = promptQueue.current.slice(1);
    setPrompts([...promptQueue.current]);
    const pending = item.prompt.type === "hostKey"
      ? answerHostKey(item.prompt.requestId, value === true)
      : answerSecret(item.prompt.requestId, typeof value === "string" ? value : null);
    void pending.catch(() => setStatus(t("app.status.promptAnswerFailed")));
  };
  useEffect(() => {
    const subscription = listen<number>("tunnel-prompt-closed", event => {
      promptQueue.current = promptQueue.current.filter(item => item.prompt.requestId !== event.payload);
      setPrompts([...promptQueue.current]);
    });
    return () => { void subscription.then(unlisten => unlisten()); };
  }, []);
  const currentPrompt = prompts[0];
  const activeTab = tabs.find(tab => tab.id === activeId) ?? null;
  const activeEditor = activeId === null ? undefined : editors[activeId];
  const browserTab = (activeTab?.kind === "diff" || activeTab?.kind === "folderDiff") ? null : activeEditor && activeTab ? browserForEditor(activeTab, activeEditor.source, tabs) : activeTab;
  const quickTarget = activeTab?.kind === "ssh" && activeTab.sessionId !== undefined && !activeTab.exited && !activeTab.savedSessionId && !activeTab.saveDismissed ? parseQuickConnect(activeTab.target ?? "") : null;
  const offerSave = quickTarget && sessionsLoaded && !savedSessions.some(session => session.host.toLowerCase() === quickTarget.host.toLowerCase() && session.port === quickTarget.port && session.user === quickTarget.user);
  const dismissSave = (tabId: number) => setTabs(current => current.map(tab => tab.id === tabId ? { ...tab, saveDismissed: true } : tab));

  const showPanel = (index: number) => { setSidebarVisible(true); setSidebarPanel(index); };
  const toggleMultiExec = () => {
    if (multiExec) {
      setMultiExec(false);
      if (tabs.some(tab => tab.id === beforeMultiExec.current)) setActiveId(beforeMultiExec.current);
    } else {
      beforeMultiExec.current = activeId;
      setUnchecked(new Set());
      setMultiExec(true);
    }
  };
  const toggleSessionLog = (id: number) => {
    const tab = tabs.find(t => t.id === id);
    if (!tab || tab.exited || tab.kind === "editor" || tab.sessionId === undefined || logBusy.current.has(id)) return;
    logBusy.current.add(id);
    const operation = logPaths[id] ? stopLog(id).then(() => onLog(id, null)) : startLog(id, tab.title, settings).then(path => {
      if (tabsRef.current.some(t => t.id === id && !t.exited)) onLog(id, path);
      else return stopLog(id);
    });
    void operation.catch(reason => setStatus(t("app.status.log", { reason: errorText(reason) }))).finally(() => logBusy.current.delete(id));
  };
  const action = (name: string) => {
    setTemporaryMenu(false);
    if (macros.action(name)) return;
    if (name.startsWith("split:")) {
      if (multiExec) return;
      const mode = name.slice(6) as SplitMode;
      if (!["columns", "rows", "quad"].includes(mode)) return;
      changeSettings({ ...settings, splitMode: mode });
      const initialPanes = seedPanes(tabs.filter(tab => tab.kind !== "editor" && tab.kind !== "diff" && tab.kind !== "folderDiff").map(tab => tab.id), activeId, paneCount(mode));
      setPanes(initialPanes);
      if (activeId === null) setActiveId(initialPanes[0]);
      setFocusedPane(0); setRatios({ x: 50, y: 50 }); return;
    }
    if (name.startsWith("saved:")) { const session = savedSessions.find(s => s.id === name.slice(6)); if (session) connectSaved(session); return; }
    if (name.startsWith("bars:")) { changeSettings({ ...settings, compact: false, bars: name.slice(5) as Settings["bars"] }); return; }
    if (name.startsWith("size:")) { changeSettings({ ...settings, toolbarSize: name.slice(5) as Settings["toolbarSize"] }); return; }
    switch (name) {
      case "paste": if (activeId !== null) terminalPasteRequests.get(activeId)?.(); break;
      case "logFolder": void openLogFolder(settings.logFolder).catch(reason => setStatus(errorText(reason))); break;
      case "logToggle": if (activeId !== null) toggleSessionLog(activeId); break;
      case "root": case "processes": case "hardware": openTab("local", name); break;
      case "compareFiles": setDiffDialog(true); break;
      case "openFile": void openFileDialog({ multiple: false, directory: false }).then(path => { if (typeof path === "string") openEditor({ id: 0, kind: "local", title: t("app.tab.local"), titleKey: "app.tab.local", exited: false, browserPath: "" }, path); }).catch(reason => setStatus(errorText(reason))); break;
      case "compact": changeSettings({ ...settings, compact: !settings.compact }); break;
      case "left": case "right": changeSettings({ ...settings, sidebarRight: name === "right" }); break;
      case "tabNumbers": changeSettings({ ...settings, tabNumbers: !settings.tabNumbers }); break;
      case "tabClose": changeSettings({ ...settings, tabClose: !settings.tabClose }); break;
      case "single": if (!multiExec) changeSettings({ ...settings, splitMode: "single" }); break;
      case "ascii": case "ports": case "keygen": setTool(name); break;
      case "tux": setTimeout(() => window.dispatchEvent(new Event(tuxTestEvent)), 100); break;
      case "local": openTab("local"); break;
      case "wsl": if (hasWsl) openTab("wsl"); break;
      case "quick": setSidebarVisible(true); requestAnimationFrame(() => document.querySelector<HTMLInputElement>("input[data-quick-connect]")?.focus()); break;
      case "close": if (activeId !== null) closeTab(activeId); break;
      case "tunnels": setTunnelsOpen(true); void reloadTunnels().catch(reason => setStatus(errorText(reason))); break;
      case "quit": void closeRequest.current(); break;
      case "newSession": setSessionDialog({}); break;
      case "sessions": showPanel(0); break;
      case "exportSessions": void chooseSessionExport([], reportStatus); break;
      case "werkterm": case "mobaxterm": case "windterm": setImportSource(name); break;
      case "sidebar": setSidebarVisible(value => !value); break;
      case "browser": showPanel(3); break;
      case "multiexec": toggleMultiExec(); break;
      case "monitoring": changeSettings({ ...settings, monitoring: !settings.monitoring }); break;
      case "larger": case "smaller": case "resetFont": {
        const delta = name === "larger" ? 1 : -1;
        if (name === "resetFont") setFontResetToken(token => token + 1); // also clears per-tab zoom offsets
        changeSettings({ ...settings, fontSize: name === "resetFont" ? 14 : settings.fontSize + delta, editorFontSize: name === "resetFont" ? 14 : settings.editorFontSize + delta }); break;
      }
      case "fullscreen": {
        if (fullscreenPending.current) break;
        fullscreenPending.current = true;
        const win = getCurrentWindow();
        void win.isFullscreen().then(value => win.setFullscreen(!value)).catch(reason => reportStatus(errorText(reason))).finally(() => { fullscreenPending.current = false; }); break;
      }
      case "settings": setSettingsOpen(true); break;
      case "shortcuts": setHelp("shortcuts"); break;
      case "about": setHelp("about"); break;
      case "updates": setUpdateOpen(true); break;
    }
  };
  const terminals = tabs.filter(tab => tab.kind !== "editor" && tab.kind !== "diff" && tab.kind !== "folderDiff");
  const splitVisible = !multiExec && settings.splitMode !== "single" && activeId !== 0 && activeTab?.kind !== "editor" && activeTab?.kind !== "diff" && activeTab?.kind !== "folderDiff";
  const terminalIds = terminals.map(tab => tab.id).join(",");
  useEffect(() => {
    if (settings.splitMode === "single") return;
    const ids = terminalIds ? terminalIds.split(",").map(Number) : [];
    setPanes(current => {
      const count = paneCount(settings.splitMode);
      let next = current.length ? cleanPanes(Array.from({ length: count }, (_, index) => current[index] ?? null), ids) : seedPanes(ids, activeId, count);
      if (splitVisible && activeId !== null && !next.includes(activeId)) next = assignPane(next, Math.min(focusedPane, count - 1), activeId);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [terminalIds, activeId, settings.splitMode, splitVisible, focusedPane]);
  const assignSplit = (index: number, id: number | null) => {
    setFocusedPane(index);
    setPanes(current => assignPane(current, index, id));
    setActiveId(id);
  };
  const gridVisible = multiExec && activeId !== 0 && activeTab?.kind !== "editor" && activeTab?.kind !== "diff" && activeTab?.kind !== "folderDiff";
  const macroRecipients = terminals.map(tab => ({ id: tab.id, exited: tab.exited || !terminalWriters.has(tab.id), checked: !unchecked.has(tab.id) }));
  const macros = useMacros({ activeId, recipients: macroRecipients, multiExec: gridVisible, report: setStatus, enabled: dataReady, showPanel: () => { showPanel(2); collapseSidebar(false); } });
  // Changes made outside (another device via the cloud folder): compare file fingerprints when the window gets focus.
  const lastFingerprintCheck = useRef(0);
  const checkingFingerprint = useRef(false);
  /** Active design that was missing in the last designs sync; it is only removed if it is missing again. */
  const missingDesign = useRef<string | null>(null);
  /** Directory stamp whose reload failed, per name: a failure is retried once per state, a lasting one is accepted. */
  const failedReloads = useRef(new Map<string, string>());
  const checkExternal = async () => {
    if (!dataReadyRef.current || checkingFingerprint.current || settingsSync.isLocked) return;
    const now = Date.now();
    if (!shouldCheck(now, lastFingerprintCheck.current)) return;
    lastFingerprintCheck.current = now;
    checkingFingerprint.current = true;
    try {
      const fresh = await dataDirFingerprint();
      const previous = fingerprint.current;
      // Outstanding own design writes: leave designs/ for a later check instead of replacing unsaved edits.
      const plan = planReload(previous, fresh, settingsSync.hasPending(), designWritesPending() ? ["designs/"] : []);
      fingerprint.current = plan.baseline;
      /** Puts the old baseline entry back, so the next focus check sees the change again. */
      const retryLater = (name: string) => { fingerprint.current = mergeEntry(fingerprint.current, previous ?? [], name); };
      const failed = (name: string) => {
        const state = JSON.stringify(fresh.find(entry => entry.name === name) ?? null);
        if (failedReloads.current.get(name) !== state) { failedReloads.current.set(name, state); retryLater(name); }
      };
      const notes: string[] = [];
      let reloaded = false;
      if (plan.reload.includes("sessions.json")) { reloadSessions(); reloaded = true; }
      if (plan.reload.includes("tunnels.json")) { await reloadTunnels(); reloaded = true; }
      if (plan.reload.includes("macros.json")) { await macros.reload(); reloaded = true; }
      if (plan.reload.includes("settings.json")) {
        const loaded = await settingsSync.reloadExternal();
        if (loaded) { applyLoadedSettings(loaded); reloaded = true; }
      }
      // Designs and icon sets after settings.json, so a renamed or switched design is matched against the new settings.
      // Own writes also change the directory stamps; they only count when the loaded content really differs.
      let removedDesign = "";
      if (plan.reload.includes("designs/")) {
        try {
          const rows = await invoke<StoredDesign[]>("designs_list");
          failedReloads.current.delete("designs/");
          if (designWritesPending()) retryLater("designs/");
          else {
            const active = settingsRef.current.design;
            const result = syncUserDesigns(rows, active, missingDesign.current);
            missingDesign.current = result.missing;
            // Missing for the first time: kept, checked again on the next focus.
            if (result.missing) retryLater("designs/");
            // An active design that changed is reapplied through designsChangedEvent; a removed one falls back in getDesign.
            if (result.activeRemoved) removedDesign = active;
            if (result.changed) reloaded = true;
          }
        } catch { failed("designs/"); notes.push(t("app.status.designsLoadFailed")); }
      }
      if (plan.reload.includes("icon-sets/")) {
        try {
          if (await reloadIconSet(settingsRef.current.iconSet)) reloaded = true;
          failedReloads.current.delete("icon-sets/");
        } catch (reason) { failed("icon-sets/"); notes.push(errorText(reason)); }
      }
      const summary = removedDesign ? t("app.status.designRemoved", { name: removedDesign }) : reloaded ? t("app.status.dataReloaded") : "";
      const message = [summary, ...notes].filter(Boolean).join("; ");
      if (message) setStatus(message);
    } catch (reason) { setStatus(t("app.status.dataDirUnreadable", { reason: errorText(reason) })); }
    finally { checkingFingerprint.current = false; }
  };
  const checkExternalRef = useRef(checkExternal);
  checkExternalRef.current = checkExternal;
  useEffect(() => {
    const onFocus = () => { void checkExternalRef.current(); };
    const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  const tabPasteChoices = useRef(new Map<number, PasteChoice>());
  const [tabPasteCount, setTabPasteCount] = useState(0);
  useEffect(() => {
    for (const id of [...tabPasteChoices.current.keys()]) if (!tabs.some(t => t.id === id)) tabPasteChoices.current.delete(id);
    setTabPasteCount(tabPasteChoices.current.size);
  }, [tabs]);
  /** Only sessions deleted in this instance are pruned; orphaned entries from other devices are harmless. */
  const sessionsDeleted = (ids: string[]) => {
    const pruned = pruneDeleted(settingsRef.current.pasteRemember, ids);
    if (pruned !== settingsRef.current.pasteRemember) changeSettings({ ...settingsRef.current, pasteRemember: pruned });
  };
  const receiveInput = (focused: number, data: string, pasted: boolean) => {
    const recipients = terminals.map(tab => ({ id: tab.id, exited: tab.exited || !terminalWriters.has(tab.id), checked: !unchecked.has(tab.id) }));
    const targets = gridVisible ? inputTargets(focused, recipients) : recipients.filter(t => t.id === focused && !t.exited).map(t => t.id);
    if (!targets.length) return;
    if (pasted && shouldConfirmPaste(data, settings.pasteConfirm)) {
      const remembered = resolveRemembered({ text: data, multiExec: gridVisible, tabChoice: tabPasteChoices.current.get(focused), sessionId: tabs.find(t => t.id === focused)?.savedSessionId, remember: settings.pasteRemember });
      if (remembered) data = applyPasteChoice(data, remembered);
      else { setPasteRequest(current => current ?? { targets, data, multiExec: gridVisible, source: focused }); return; }
    }
    macros.capture(focused, pasted ? data.replace(/\r\n|\n/g, "\r") : data);
    targets.forEach(id => terminalWriters.get(id)?.(data, pasted));
  };
  const menus = createMenus({ macros: macros.items, recording: macros.recording, savedSessions, settings, hasWsl, activeId, multiExec, updateVersion, logging: !!(activeId && logPaths[activeId]), canLog: !!activeTab && activeTab.kind !== "editor" && activeTab.kind !== "diff" && activeTab.kind !== "folderDiff" && !activeTab.exited && activeTab.sessionId !== undefined, canPaste: !!activeTab && activeTab.kind !== "editor" && activeTab.kind !== "diff" && activeTab.kind !== "folderDiff" && !activeTab.exited && activeTab.sessionId !== undefined, isLinux: /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent) });
  const restoreTabs = () => setRestoreQueue([...lastTabs]);
  /** Switch from the settings dialog: same prompts as "Beenden", then data_dir_set and restart. Rejects with the error shown in the dialog. */
  const restartWithDataDir = async (path: string | null, copy: boolean) => { await closeRequest.current({ kind: "dataDir", path, copy }); };
  /** Update dialog: same sequence as the folder switch; the install replaces data_dir_set. False when the user declined a prompt. */
  const installUpdate = (request: InstallRequest, onProgress: (progress: UpdateProgress) => void): Promise<boolean> => closeRequest.current({ kind: "update", install: () => updateInstall(request, onProgress) });
  const statusText = transfer ? (transfer.queued > 0 ? t("app.status.transferQueued", { text: transfer.text, queued: transfer.queued }) : transfer.text) : activeEditor ? (activeEditor.status || t("app.editor")) : (status || t("app.status.ready"));

  return <div className={`app-shell toolbar-${settings.toolbarSize} ${settings.compact ? "compact" : ""}`}>
    <div hidden={!temporaryMenu && (settings.compact || settings.bars === "toolbar")}><MenuBar menus={menus} onAction={action} /></div>
    {!settings.compact && settings.bars !== "menu" && <Toolbar hasWsl={hasWsl} menus={menus} shellName={shellName} multiExec={multiExec} onAction={action} />}
    <div className={`workspace ${settings.sidebarRight ? "sidebar-right" : ""}`}>
      <div className="workspace-header">{sidebarVisible && <div className="quick-connect-slot" style={{ width: `calc(var(--sidebar-icon-width) + ${sidebarWidth}px)` }}><QuickConnect onConnect={connect} onStatus={reportStatus} /></div>}<TabBar onLogToggle={toggleSessionLog} onOpenLogFolder={() => action("logFolder")} showNumbers={settings.tabNumbers} showClose={settings.tabClose} tabs={tabs.map(tab => ({ ...tab, recording: macros.recordingId === tab.id, connected: tab.sessionId !== undefined, shell: shellName, logPath: logPaths[tab.id], dirty: editors[tab.id]?.dirty, tooltip: editors[tab.id]?.document.path ?? (() => { const session = savedSessions.find(s => s.id === tab.savedSessionId); return session ? [tab.title, jumpHostHint(session, savedSessions)].filter(Boolean).join(" – ") : tab.title; })() }))} activeId={activeId} hasWsl={hasWsl} onOpen={openTab} onClose={closeTab} onSelect={id => { if (panes.includes(id)) setFocusedPane(panes.indexOf(id)); setActiveId(id); }} /></div>
      <div className="workspace-body">
      {sidebarVisible && <Sidebar width={sidebarWidth} onWidthChange={resizeSidebar} macrosPanel={macros.panel} markedSource={markedSource} onCompareFile={compareBrowserFile} collapsed={sidebarCollapsed} onCollapsedChange={collapseSidebar} toolItems={menus.find(menu => menu.id === "tools")?.items ?? []} onToolAction={action} onMultiExec={toggleMultiExec} active={sidebarPanel} onActive={setSidebarPanel} onOpenSettings={() => setSettingsOpen(true)} onAccess={setBrowserAccess} onOpenFile={openEditor} savedSessions={savedSessions} onSavedConnect={connectSaved} onEditSession={session => setSessionDialog({ session })} onReloadSessions={reloadSessions} onSessionsDeleted={sessionsDeleted} sessionFolders={sessionFolders} onSessionsWritten={sessionsWritten} onUndoable={(message, undo) => { reportStatus(message); undoSlot.offer(message, undo); }} transferQueue={transferQueue} onStatus={reportStatus} tab={browserTab} settings={settings} onSettings={changeSettings} onPath={setPath} />}
      <main className="terminal-workspace" aria-label={t("app.terminalArea")}>

        {activeId === 0 && <Home sessions={savedSessions} recents={recents} canRestore={lastTabs.length > 0 && sessionsLoaded && shellsLoaded && restoreQueue === null} onLocal={() => openTab("local")} onRestore={restoreTabs} onSaved={connectSaved} onQuick={connect} />}
        {offerSave && activeTab && quickTarget && <div className="connection-save"><span>{t("app.saveConnection.question")}</span><button title={t("app.saveConnection.title")} onClick={() => setSessionDialog({ tabId: activeTab.id, preferPassword: true, session: { kind: "ssh", id: "", name: `${quickTarget.user}@${quickTarget.host}`, folder: "", host: quickTarget.host, port: quickTarget.port, user: quickTarget.user, auth: { type: "default" }, source: null, ...(quickTarget.sshOptions ? { sshOptions: quickTarget.sshOptions.join("\n") } : {}) } })}>{t("app.saveConnection.save")}</button><button title={t("app.saveConnection.dismissTitle")} onClick={() => dismissSave(activeTab.id)}>{t("app.saveConnection.dismiss")}</button></div>}
        {gridVisible && <div className="multiexec-header"><strong>{t("app.multiExec.active")}</strong><button onClick={() => setUnchecked(new Set())}>{t("app.multiExec.all")}</button><button onClick={() => setUnchecked(new Set(terminals.map(t => t.id)))}>{t("app.multiExec.none")}</button><button onClick={toggleMultiExec}>{t("app.multiExec.end")}</button></div>}
        <div className={`terminal-stack ${gridVisible ? "multiexec-grid" : ""}`} style={gridVisible ? { gridTemplateColumns: `repeat(${gridColumns(terminals.length)}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(terminals.length / gridColumns(terminals.length))}, minmax(0, 1fr))` } : undefined}>
          <Suspense fallback={null}>{tabs.filter(tab => tab.kind !== "editor" && tab.kind !== "diff" && tab.kind !== "folderDiff").map(tab => <TerminalView fontResetToken={fontResetToken} logPath={logPaths[tab.id]} connected={tab.sessionId !== undefined} onLogToggle={toggleSessionLog} title={tab.title} logAlways={!!savedSessions.find(s => s.id === tab.savedSessionId)?.log_always} onLog={onLog} key={`${tab.id}:${tab.generation ?? 0}`} id={tab.id} serial={tab.serial} kind={tab.kind as ShellKind | "ssh" | "telnet" | "serial"} target={tab.target} savedSessionId={tab.savedSessionId} startCommand={tab.startCommand} active={tab.id === activeId} visible={splitVisible ? panes.includes(tab.id) : gridVisible || tab.id === activeId} paneStyle={splitVisible && panes.includes(tab.id) ? { ...paneStyle(settings.splitMode, panes.indexOf(tab.id), ratios.x, ratios.y), paddingTop: 38 } : undefined} onFocusPane={splitVisible ? () => { setFocusedPane(panes.indexOf(tab.id)); setActiveId(tab.id); } : gridVisible ? () => { if (tab.id !== activeId) setActiveId(tab.id); } : undefined} exited={tab.exited}
            onInput={receiveInput} monitoringSession={settings.monitoring && tab.id === activeId && tab.kind === "ssh" && !tab.exited ? tab.sessionId : undefined}
            gridFooter={gridVisible ? <div className="multiexec-footer"><span>{tab.title}</span><label><input type="checkbox" disabled={tab.exited} checked={!unchecked.has(tab.id)} onChange={e => setUnchecked(current => { const next = new Set(current); if (e.target.checked) next.delete(tab.id); else next.add(tab.id); return next; })} />{t("app.multiExec.receive")}</label></div> : undefined}
            preferences={settings} shellIntegration={settings.shellIntegration} sshPromptCommand={settings.sshPromptCommand}
            onSerialPermission={(id, info) => setSerialPermission({ id, info })} onExit={markExited} onCloseTab={closeTab} onRestart={restartTab} onStatus={setStatus} onSession={setSession} onCwd={setCwd} onPrompt={queuePrompt} onClearPrompts={removePrompts} />)}</Suspense>
          {splitVisible && <SplitLayout mode={settings.splitMode} panes={panes} terminals={terminals} focusedIndex={activeId !== null && panes.includes(activeId) ? panes.indexOf(activeId) : focusedPane} ratios={ratios} onRatios={setRatios} onAssign={assignSplit}
            onFocus={index => { setFocusedPane(index); setActiveId(panes[index] ?? null); }}
            onNew={index => { setFocusedPane(index); const id = nextId.current; openTab("local"); setPanes(current => assignPane(current, index, id)); }} />}
          {Object.entries(folderDiffs).map(([key, pair]) => <div key={key} id={`folderDiff-${key}`} role="tabpanel" aria-labelledby={`tab-${key}`} hidden={activeId !== Number(key)} style={{ height: "100%" }}><FolderDiffView initial={pair} onOpen={compareFiles} onTitle={sources => setTabs(current => current.map(tab => tab.id === Number(key) ? { ...tab, ...folderDiffTitle(sources) } : tab))} /></div>)}
          <Suspense fallback={null}>{Object.entries(diffs).map(([key, pair]) => <div key={key} id={`diff-${key}`} role="tabpanel" aria-labelledby={`tab-${key}`} hidden={activeId !== Number(key)} style={{ height: "100%" }}><DiffView pair={pair} settings={settings} onOpen={source => openEditor(source.tab, source.path)} /></div>)}</Suspense>
          <Suspense fallback={<div className="terminal-empty">{t("app.status.editorLoading")}</div>}>{Object.entries(editors).map(([key, editor]) => {
            const id = Number(key);
            return <div key={id} id={`editor-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} hidden={activeId !== id} style={{ height: "100%" }}><EditorView settings={settings} fontResetToken={fontResetToken} ref={handle => { if (handle) editorHandles.current.set(id, handle); else editorHandles.current.delete(id); }} document={editor.document}
              onDirtyChange={dirty => setEditors(current => !current[id] || current[id].dirty === dirty ? current : { ...current, [id]: { ...current[id], dirty } })}
              onStatusChange={status => setEditors(current => !current[id] || current[id].status === status ? current : { ...current, [id]: { ...current[id], status } })}
              onDocumentChange={document => setEditors(current => !current[id] ? current : { ...current, [id]: { ...current[id], document } })} /></div>;
          })}</Suspense>
        </div>
      </main>
      </div>
    </div>
    <footer className="statusbar" role="status" aria-live="polite">
      {transfer && <><button type="button" onClick={() => transferQueue.cancelCurrent()}>{t("common.cancel")}</button><progress aria-label={transfer.text} max={1} {...(transfer.progress === null ? {} : { value: transfer.progress })} /></>}
      {transfer && <span className="statusbar-text" title={statusText}>{statusText}</span>}
      {macros.playing && <button onClick={macros.cancel}>{t("app.footer.cancelMacro")}</button>}{activeTunnels > 0 && <button onClick={() => setTunnelsOpen(true)}>{t("app.footer.tunnels", { count: activeTunnels })}</button>}{updateVersion && <button type="button" className="update-available" onClick={() => setUpdateOpen(true)}>{t("app.footer.updateAvailable", { version: updateVersion })}</button>}{multiExec && <span>{tp("app.multiExec.status", terminals.length, { active: terminals.filter(tab => !tab.exited && !unchecked.has(tab.id)).length })} · </span>}{activeTab && connectionStatus(activeTab.kind, activeTab.serial) && <span>{connectionStatus(activeTab.kind, activeTab.serial)} · </span>}{!transfer && <span title={statusText}>{statusText}</span>}{undoEntry && !transfer && (activeEditor ? activeEditor.status : status) === undoEntry.message && <button type="button" onClick={undoSlot.take}>{t("app.footer.undo")}</button>}</footer>
    {macros.dialogs}
    {pasteRequest && <PasteDialog text={pasteRequest.data} count={pasteRequest.targets.length} multiExec={pasteRequest.multiExec} hasProfile={!pasteRequest.multiExec && !!tabs.find(t => t.id === pasteRequest.source)?.savedSessionId} onAnswer={(text, remember) => {
      if (text !== null && remember && (remember.scope === "global" || !pasteRequest.multiExec)) {
        const source = pasteRequest.source;
        if (remember.scope === "tab") {
          if (tabsRef.current.some(t => t.id === source)) { tabPasteChoices.current.set(source, remember.choice); setTabPasteCount(tabPasteChoices.current.size); } else setStatus(t("app.status.choiceNotRemembered"));
        } else {
          const before = settingsRef.current.pasteRemember;
          const after = rememberChoice(before, remember.scope, tabsRef.current.find(t => t.id === source)?.savedSessionId, remember.choice);
          if (after === before) setStatus(t("app.status.choiceNotRemembered")); else changeSettings({ ...settingsRef.current, pasteRemember: after });
        }
      }
      if (text !== null && tabsRef.current.some(t => t.id === pasteRequest.source && !t.exited)) macros.capture(pasteRequest.source, text.replace(/\r\n|\n/g, "\r"));
      if (text !== null) pasteRequest.targets.forEach(id => { if (tabsRef.current.some(t => t.id === id && !t.exited)) terminalWriters.get(id)?.(text, true); });
      setPasteRequest(null);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`#terminal-${activeId} .xterm-helper-textarea`)?.focus());
    }} />}
    {tunnelsOpen && <TunnelDialog sessions={savedSessions} tunnels={tunnels} statuses={tunnelStatuses} reload={reloadTunnels} start={startTunnel} onClose={() => setTunnelsOpen(false)} />}
    {tunnelConfirmation && <TunnelConfirmDialog onAnswer={accepted => { setTunnelConfirmation(null); tunnelConfirmation(accepted); }} />}
    {diffDialog && <DiffDialog onCompare={compareFiles} onClose={() => setDiffDialog(false)} />}
    {tool && <ToolDialog kind={tool} onClose={() => setTool(null)} />}
    {settingsOpen && <SettingsDialog settings={settings} onChange={changeSettings} tabPasteCount={tabPasteCount} onResetTabPaste={() => { tabPasteChoices.current.clear(); setTabPasteCount(0); }} onClearRecents={() => { void invoke("recent_clear").then(() => setRecents([])).catch(reason => setStatus(errorText(reason))); }} onClose={() => setSettingsOpen(false)}
      onChangeDataDir={current => { void pickForChange(current); }} onDefaultDataDir={current => changeDataDirFrom(current, { kind: "default", path: current.defaultPath })} />}
    {dataDirChange && <DataDirDialog mode="change" status={dataDirChange.status} initialChoice={dataDirChange.choice} onApply={restartWithDataDir} onCancel={() => setDataDirChange(null)} />}
    {dataPhase === "setup" && dataStatus && <DataDirDialog mode="setup" status={dataStatus} notice={setupNotice} onApply={applyStartupChoice(true)} />}
    {dataPhase === "unreachable" && dataStatus && <DataDirDialog mode="unreachable" status={dataStatus} onApply={applyStartupChoice(false)} onRetry={retryDataDir} />}
    {dataPhase === "error" && <DataDirErrorDialog message={dataError} busy={dataErrorBusy} error={dataErrorAction}
      onRetry={() => void runDataErrorAction(async () => { await bootstrapData(); })} onReset={() => void runDataErrorAction(resetPointer)} />}
    {transfersPrompt && <UpdateTransfersDialog count={transfersPrompt.count} onAnswer={transfersPrompt.answer} />}
    {updateOpen && <UpdateDialog channel={settings.updateChannel} onInstall={installUpdate} onChecked={update => setUpdateVersion(markerVersion(update))} onClose={() => setUpdateOpen(false)} />}
    {restartRequired && <RestartDialog busy={restartBusy} error={restartError} update={restartForUpdate} notInstalled={restartNotInstalled} onRestart={() => void retryRestart()} />}
    {serialPermission && <SerialPermissionDialog key={serialPermission.id} info={serialPermission.info}
      onClose={() => setSerialPermission(null)}
      onRetry={() => { setActiveId(serialPermission.id); restartTab(serialPermission.id); setSerialPermission(null); }}
      onExecute={command => new Promise<void>((resolve, reject) => {
        if (windowClosing.current) { reject(new Error(t("app.error.windowClosing"))); return; }
        const id = nextId.current;
        serialFixCommands.set(id, { command, resolve, reject });
        openTab("local");
      })} />}
    {help && <HelpDialog about={help === "about"} channel={settings.updateChannel} onClose={() => setHelp(null)} />}
    {importSource === "werkterm" && <WerktermImportDialog onClose={() => setImportSource(null)} onImported={result => { setImportSource(null); reloadSessions(); reportStatus([tp("app.import.result", result.imported, { skipped: result.skippedDuplicates }), ...(result.warnings ?? []).map(errorText)].join("; ")); }} />}
    {importSource && importSource !== "werkterm" && <ImportDialog source={importSource} onClose={() => setImportSource(null)} onImported={result => { setImportSource(null); reloadSessions(); reportStatus(tp("app.import.done", result.imported)); }} />}
    {sshClose && <SshCloseDialog {...sshClose} onAnswer={sshClose.answer} />}
    {closeEditorId !== null && editors[closeEditorId] && <EditorCloseDialog key={closeEditorId} name={editors[closeEditorId].document.name} busy={closeEditorBusy} onAnswer={answer => void answerEditorClose(answer)} />}
    {sessionDialog && <SessionDialog session={sessionDialog.session} preferPassword={sessionDialog.preferPassword} sessions={savedSessions} rememberedPaste={rememberedForSession(settings.pasteRemember, sessionDialog.session?.id)} onResetPaste={() => { const id = sessionDialog.session?.id; if (!id) return; const current = settingsRef.current; const next = resetRememberedSession(current.pasteRemember, id); if (next !== current.pasteRemember) changeSettings({ ...current, pasteRemember: next }); }} onClose={() => setSessionDialog(null)} onSaved={saved => { const isNew = !sessionDialog.session?.id && sessionDialog.tabId === undefined; if (sessionDialog.tabId !== undefined) dismissSave(sessionDialog.tabId); setSessionDialog(null); reloadSessions(); setStatus(t("app.status.sessionSaved")); if (isNew) connectSaved(saved); }} />}
    {userSession && <SessionUserDialog name={userSession.name} onAnswer={user => { const session = userSession; setUserSession(null); if (user !== null) connectSaved(session, user); }} />}
    {quickUserTarget && <SessionUserDialog name={quickUserTarget} onAnswer={user => { const target = quickUserTarget; setQuickUserTarget(null); if (user !== null) connect(withQuickConnectUser(target, user)); }} />}
    {conflict && <FileActionDialog key={conflictSequence} prompt={conflict} />}
    {currentPrompt?.prompt.type === "hostKey" && <HostKeyDialog key={currentPrompt.prompt.requestId} prompt={currentPrompt.prompt} onAnswer={value => answer(currentPrompt, value)} />}
    {currentPrompt?.prompt.type === "secret" && <SecretDialog key={currentPrompt.prompt.requestId} prompt={currentPrompt.prompt} onAnswer={value => answer(currentPrompt, value)} />}
  </div>;
}
