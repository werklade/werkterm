import type { Macro } from "./macros";
import type { AppMenu } from "../components/MenuBar";
import { Icon } from "../components/Icon";
import type { Settings } from "./settings";
import type { SavedSession } from "./sessions";
import { getLanguage, t, type Language } from "../i18n";
import { formatShortcut } from "./formatShortcut";
import type { ShellProfile } from "./pty";
import { profileMenuItems } from "./shellProfiles";

export type MenuId = "edit" | "terminal" | "sessions" | "macros" | "view" | "split" | "tools" | "settings" | "help";
/**
 * Index of the mnemonic letter within the translated top-level menu label.
 * Must be unique per language (case-insensitive); enforced by a unit test.
 */
export const menuMnemonics: Record<Language, Record<MenuId, number>> = {
  // Bearbeiten, Terminal, Sitzungen, Makros, Ansicht, Teilen (i), Werkzeuge, Einstellungen, Hilfe
  de: { edit: 0, terminal: 0, sessions: 0, macros: 0, view: 0, split: 2, tools: 0, settings: 0, help: 0 },
  // Edit, Terminal, Sessions, Macros, View, Split (p), Tools (o), Settings (i), Help
  en: { edit: 0, terminal: 0, sessions: 0, macros: 0, view: 0, split: 1, tools: 1, settings: 4, help: 0 },
};

export function createMenus({ macros = [], recording = false, savedSessions, settings, hasWsl, profiles = [], activeId, multiExec, logging = false, canLog = !!activeId, canPaste = !!activeId, isLinux, updateVersion = null }: {
  macros?: Macro[]; recording?: boolean; savedSessions: SavedSession[]; settings: Settings; hasWsl: boolean; /** Installed shells; listed in the Terminal menu when there is more than one. */ profiles?: ShellProfile[]; activeId: number | null; multiExec: boolean; logging?: boolean; canLog?: boolean; canPaste?: boolean; isLinux: boolean;
  /** Version found by the opt-in start check; marks the update entry in the Help menu. */
  updateVersion?: string | null;
}): AppMenu[] {
  const sidebarVisible = settings.sidebarVisible;
  const mnemonic = (id: MenuId) => menuMnemonics[getLanguage()][id];
  /** `key` is language independent; the label is only displayed. */
  const heading = (key: string, label: string) => ({ label, action: `heading:${key}`, heading: true });
  const radio = (label: string, action: string, checked: boolean) => ({ label, action, checked, radio: true });
  const noFolder = t("menu.sessions.noFolder");
  const folders = [...new Set(savedSessions.map(s => s.folder || noFolder))].sort();
  const ctrlShift = (key: string) => formatShortcut(["ctrl", "shift", key]);
  return [
    { id: "edit", label: t("menu.edit"), mnemonic: mnemonic("edit"), items: [{ label: t("menu.edit.paste"), action: "paste", disabled: !canPaste }] },
    { id: "terminal", label: t("menu.terminal"), mnemonic: mnemonic("terminal"), items: [
      { label: t("menu.terminal.local"), action: "local", shortcut: ctrlShift("T") },
      ...(hasWsl ? [{ label: "WSL", action: "wsl" }] : []),
      ...(profiles.length > 1 ? [{ label: "", action: "terminal-profiles-start", separator: true }, ...profileMenuItems(profiles, "terminal-profiles"), { label: "", action: "terminal-profiles-end", separator: true }] : []),
      { label: logging ? t("menu.terminal.logStop") : t("menu.terminal.logStart"), action: "logToggle", disabled: !canLog },
      { label: t("menu.terminal.logFolder"), action: "logFolder" },
      { label: t("menu.terminal.quick"), action: "quick" }, { label: t("menu.terminal.close"), action: "close", shortcut: ctrlShift("W"), disabled: activeId === 0 }, { label: t("menu.terminal.quit"), action: "quit" },
    ] },
    { id: "sessions", label: t("menu.sessions"), mnemonic: mnemonic("sessions"), items: [
      { label: t("menu.sessions.new"), action: "newSession" }, { label: t("menu.sessions.panel"), action: "sessions" },
      { label: "", action: "sessions-transfer-separator", separator: true },
      { label: t("menu.sessions.export"), action: "exportSessions" }, { label: t("menu.sessions.importWerkterm"), action: "werkterm" },
      { label: t("menu.sessions.importMobaxterm"), action: "mobaxterm" }, { label: t("menu.sessions.importWindterm"), action: "windterm" },
      ...(savedSessions.length ? [{ label: "", action: "sessions-saved-separator", separator: true }] : []),
      ...folders.flatMap(folder => [heading(`folder:${folder}`, folder), ...savedSessions.filter(s => (s.folder || noFolder) === folder).map(s => ({ label: `  ${s.name}`, action: `saved:${s.id}`, icon: <Icon name={s.kind === "ssh" ? "ssh" : "terminal"}/> }))]),
    ] },
    { id: "macros", label: t("menu.macros"), mnemonic: mnemonic("macros"), items: [
      { label: recording ? t("menu.macros.recordStop") : t("menu.macros.recordStart"), action: "macro:record" },
      { label: t("menu.macros.new"), action: "macro:new" },
      { label: "", action: "macro:separator1", separator: true },
      ...macros.map(item => ({ label: item.name, action: `macro:play:${item.id}`, shortcut: item.shortcut ?? undefined })),
      { label: "", action: "macro:separator2", separator: true },
      { label: t("menu.macros.manage"), action: "macros" },
    ] },
    { id: "view", label: t("menu.view"), mnemonic: mnemonic("view"), items: [
      heading("bars", t("menu.view.barsHeading")), radio(t("menu.view.showMenu"), "bars:menu", settings.bars === "menu"), radio(t("menu.view.showToolbar"), "bars:toolbar", settings.bars === "toolbar"), radio(t("menu.view.showBoth"), "bars:both", settings.bars === "both"),
      heading("toolbar", t("menu.view.toolbarHeading")), radio(t("menu.view.sizeSmall"), "size:small", settings.toolbarSize === "small"), radio(t("menu.view.sizeStandard"), "size:standard", settings.toolbarSize === "standard"), radio(t("menu.view.sizeLabels"), "size:labels", settings.toolbarSize === "labels"), { label: t("menu.view.compact"), action: "compact", checked: settings.compact },
      heading("sidebar", t("menu.view.sidebarHeading")), { label: t("menu.view.sidebarToggle"), action: "sidebar", checked: sidebarVisible }, radio(t("menu.view.sidebarLeft"), "left", !settings.sidebarRight), radio(t("menu.view.sidebarRight"), "right", settings.sidebarRight),
      heading("tabs", t("menu.view.tabsHeading")), { label: t("menu.view.tabNumbers"), action: "tabNumbers", checked: settings.tabNumbers }, { label: t("menu.view.tabClose"), action: "tabClose", checked: settings.tabClose },
      { label: t("menu.view.monitoring"), action: "monitoring", checked: settings.monitoring }, { label: t("menu.view.fontLarger"), action: "larger", shortcut: ctrlShift("Plus") }, { label: t("menu.view.fontSmaller"), action: "smaller", shortcut: ctrlShift("Minus") }, { label: t("menu.view.fontReset"), action: "resetFont", shortcut: ctrlShift("0") }, { label: t("menu.view.fullscreen"), action: "fullscreen", shortcut: "F11" },
    ] },
    { id: "split", label: t("menu.split"), mnemonic: mnemonic("split"), items: [{ ...radio(t("menu.split.single"), "single", settings.splitMode === "single"), disabled: multiExec }, ...([ [t("menu.split.columns"), "columns"], [t("menu.split.rows"), "rows"], [t("menu.split.quad"), "quad"] ] as const).map(([label, mode]) => ({ ...radio(label, `split:${mode}`, settings.splitMode === mode), disabled: multiExec }))] },
    { id: "tools", label: t("menu.tools"), mnemonic: mnemonic("tools"), items: [heading("system", t("menu.tools.systemHeading")), { label: t("menu.terminal.local"), action: "local" }, ...(isLinux ? [{ label: t("menu.tools.root"), action: "root" }, { label: t("menu.tools.processes"), action: "processes" }] : []), { label: t("menu.tools.hardware"), action: "hardware" }, { label: t("menu.tools.tux"), action: "tux" },
      heading("editor", t("menu.tools.editorHeading")), { label: t("menu.tools.openFile"), action: "openFile" }, { label: t("menu.tools.ascii"), action: "ascii" }, { label: t("menu.tools.compareFiles"), action: "compareFiles" },
      heading("network", t("menu.tools.networkHeading")), { label: t("menu.tools.keygen"), action: "keygen" }, { label: t("menu.tools.ports"), action: "ports" }, { label: t("menu.tools.tunnels"), action: "tunnels" },
      { label: "", action: "tools-separator", separator: true }, { label: t("menu.tools.multiexec"), action: "multiexec", checked: multiExec, inlineCheck: true, shortcut: ctrlShift("M") }, { label: t("menu.settings.open"), action: "settings", shortcut: formatShortcut(["ctrl", ","]) },
    ] },
    { id: "settings", label: t("menu.settings"), mnemonic: mnemonic("settings"), items: [{ label: t("menu.settings.open"), action: "settings" }] },
    { id: "help", label: t("menu.help"), mnemonic: mnemonic("help"), items: [{ label: t("menu.help.shortcuts"), action: "shortcuts" }, { label: updateVersion ? t("menu.help.updatesAvailable", { version: updateVersion }) : t("menu.help.updates"), action: "updates" }, { label: t("menu.help.about"), action: "about" }] },
  ];
}
