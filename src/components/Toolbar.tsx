import { MenuBar, type AppMenu } from "./MenuBar";
import { Icon, type IconName } from "./Icon";
import { useT } from "../i18n";
import type { MenuId } from "../lib/actions";
export function Toolbar({ hasWsl, menus, shellName, multiExec, onAction }: { hasWsl: boolean; menus: AppMenu[]; shellName: string; multiExec: boolean; onAction(action: string): void }) {
  const t = useT();
  const button = (id: string, label: string, icon: IconName, action: string, tooltip = label, disabled = false) => <button key={id} type="button" className={`toolbar-button ${action === "multiexec" && multiExec ? "active" : ""}`} aria-label={label} aria-pressed={action === "multiexec" ? multiExec : undefined} title={tooltip} disabled={disabled} onClick={() => onAction(action)}><Icon name={icon}/><span>{label}</span></button>;
  const menu = (id: MenuId, icon: IconName) => { const definition = menus.find(m => m.id === id); return definition && <MenuBar key={id} menus={[definition]} onAction={onAction} toolbarIcon={<Icon name={icon}/>}/>; };
  return <div className="toolbar" aria-label={t("toolbar.label")}>
    {button("session", t("toolbar.session"), "session-new", "newSession", t("toolbar.newSession"))}{menu("sessions", "star")}
    {button("local", t("menu.terminal.local"), "terminal", "local", shellName)}{hasWsl && button("wsl", "WSL", "tux", "wsl")}
    {menu("tools", "tools")}{menu("view", "view")}{menu("split", "split")}
    {button("multiexec", t("menu.tools.multiexec"), "multiexec", "multiexec")}{button("settings", t("toolbar.settings"), "settings", "settings")}{menu("help", "help")}
    {menu("macros", "macros")}<div className="toolbar-spacer"/>{button("quit", t("menu.terminal.quit"), "power", "quit")}
  </div>;
}
