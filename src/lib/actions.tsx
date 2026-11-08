import type { Macro } from "./macros";
import type { AppMenu } from "../components/MenuBar";
import { Icon } from "../components/Icon";
import type { Settings } from "./settings";
import type { SavedSession } from "./sessions";
export function createMenus({ macros = [], recording = false, savedSessions, settings, hasWsl, activeId, multiExec, logging = false, canLog = !!activeId, canPaste = !!activeId, isLinux }: {
  macros?: Macro[]; recording?: boolean; savedSessions: SavedSession[]; settings: Settings; hasWsl: boolean; activeId: number | null; multiExec: boolean; logging?: boolean; canLog?: boolean; canPaste?: boolean; isLinux: boolean;
}): AppMenu[] {
  const sidebarVisible = settings.sidebarVisible;
  const heading = (label: string) => ({ label, action: `heading:${label}`, heading: true });
  const radio = (label: string, action: string, checked: boolean) => ({ label, action, checked, radio: true });
  const folders = [...new Set(savedSessions.map(s => s.folder || "Ohne Ordner"))].sort();
  return [
    { label: "Bearbeiten", mnemonic: 0, items: [{ label: "Einfügen", action: "paste", disabled: !canPaste }] },
    { label: "Terminal", mnemonic: 0, items: [
      { label: "Lokales Terminal", action: "local", shortcut: "Strg+Umschalt+T" },
      ...(hasWsl ? [{ label: "WSL", action: "wsl" }] : []),
      { label: logging ? "Protokoll stoppen" : "Protokoll starten", action: "logToggle", disabled: !canLog },
      { label: "Protokollordner öffnen", action: "logFolder" },
      { label: "Quick connect…", action: "quick" }, { label: "Tab schließen", action: "close", shortcut: "Strg+Umschalt+W", disabled: activeId === 0 }, { label: "Beenden", action: "quit" },
    ] },
    { label: "Sessions", mnemonic: 0, items: [
      { label: "Neue Sitzung…", action: "newSession" }, { label: "Sitzungs-Panel anzeigen", action: "sessions" },
      { label: "", action: "sessions-transfer-separator", separator: true },
      { label: "Sitzungen exportieren…", action: "exportSessions" }, { label: "Import aus Werkterm-Datei…", action: "werkterm" },
      { label: "Import aus MobaXterm…", action: "mobaxterm" }, { label: "Import aus WindTerm…", action: "windterm" },
      ...(savedSessions.length ? [{ label: "", action: "sessions-saved-separator", separator: true }] : []),
      ...folders.flatMap(folder => [heading(folder), ...savedSessions.filter(s => (s.folder || "Ohne Ordner") === folder).map(s => ({ label: `  ${s.name}`, action: `saved:${s.id}`, icon: <Icon name={s.kind === "ssh" ? "ssh" : "terminal"}/> }))]),
    ] },
    { label: "Makros", mnemonic: 0, items: [
      { label: recording ? "Aufnahme stoppen" : "Aufnahme starten", action: "macro:record" },
      { label: "Neues Makro…", action: "macro:new" },
      { label: "", action: "macro:separator1", separator: true },
      ...macros.map(item => ({ label: item.name, action: `macro:play:${item.id}`, shortcut: item.shortcut ?? undefined })),
      { label: "", action: "macro:separator2", separator: true },
      { label: "Makros verwalten", action: "macros" },
    ] },
    { label: "View", mnemonic: 0, items: [
      heading("Menü und Werkzeugleiste"), radio("Menüleiste anzeigen", "bars:menu", settings.bars === "menu"), radio("Werkzeugleiste anzeigen", "bars:toolbar", settings.bars === "toolbar"), radio("Beides", "bars:both", settings.bars === "both"),
      heading("Werkzeugleiste"), radio("Kleine Buttons", "size:small", settings.toolbarSize === "small"), radio("Standard", "size:standard", settings.toolbarSize === "standard"), radio("Standard mit Beschriftung", "size:labels", settings.toolbarSize === "labels"), { label: "Kompaktmodus", action: "compact", checked: settings.compact },
      heading("Seitenleiste"), { label: "Seitenleiste ein-/ausblenden", action: "sidebar", checked: sidebarVisible }, radio("Links", "left", !settings.sidebarRight), radio("Rechts", "right", settings.sidebarRight),
      heading("Tabs"), { label: "Tab-Nummern anzeigen", action: "tabNumbers", checked: settings.tabNumbers }, { label: "Schließen-Button anzeigen", action: "tabClose", checked: settings.tabClose },
      { label: "Monitoring-Leiste", action: "monitoring", checked: settings.monitoring }, { label: "Schrift größer", action: "larger", shortcut: "Strg+Umschalt+Plus" }, { label: "Schrift kleiner", action: "smaller", shortcut: "Strg+Umschalt+Minus" }, { label: "Schrift Standard", action: "resetFont", shortcut: "Strg+Umschalt+0" }, { label: "Vollbild", action: "fullscreen", shortcut: "F11" },
    ] },
    { label: "Split", mnemonic: 1, items: [{ ...radio("Ein Terminal", "single", settings.splitMode === "single"), disabled: multiExec }, ...([ ["Zwei nebeneinander", "columns"], ["Zwei untereinander", "rows"], ["Vier Terminals", "quad"] ] as const).map(([label, mode]) => ({ ...radio(label, `split:${mode}`, settings.splitMode === mode), disabled: multiExec }))] },
    { label: "Tools", mnemonic: 1, items: [heading("System"), { label: "Lokales Terminal", action: "local" }, ...(isLinux ? [{ label: "Root-Terminal", action: "root" }, { label: "Laufende Prozesse", action: "processes" }, { label: "Hardware anzeigen", action: "hardware" }] : []), { label: "Tux-Wanderer starten", action: "tux" },
      heading("Editor"), { label: "Lokale Datei öffnen…", action: "openFile" }, { label: "ASCII-Tabelle", action: "ascii" }, { label: "Dateien vergleichen…", action: "compareFiles" },
      heading("Netzwerk"), { label: "SSH-Schlüssel erzeugen", action: "keygen" }, { label: "Offene lokale Ports", action: "ports" }, { label: "SSH-Tunnel", action: "tunnels" },
      { label: "", action: "tools-separator", separator: true }, { label: "MultiExec", action: "multiexec", checked: multiExec, inlineCheck: true, shortcut: "Strg+Umschalt+M" }, { label: "Einstellungen…", action: "settings", shortcut: "Strg+," },
    ] },
    { label: "Settings", mnemonic: 1, items: [{ label: "Einstellungen…", action: "settings" }] },
    { label: "Help", mnemonic: 0, items: [{ label: "Tastenkürzel", action: "shortcuts" }, { label: "Über Werkterm", action: "about" }] },
  ];
}
