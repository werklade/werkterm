import { MenuBar, type AppMenu } from "./MenuBar";
import { Icon, type IconName } from "./Icon";
export function Toolbar({ hasWsl, menus, shellName, multiExec, onAction }: { hasWsl: boolean; menus: AppMenu[]; shellName: string; multiExec: boolean; onAction(action: string): void }) {
  const button = (label: string, icon: IconName, action: string, tooltip = label, disabled = false) => <button key={label} type="button" className={`toolbar-button ${action === "multiexec" && multiExec ? "active" : ""}`} aria-label={label} aria-pressed={action === "multiexec" ? multiExec : undefined} title={tooltip} disabled={disabled} onClick={() => onAction(action)}><Icon name={icon}/><span>{label}</span></button>;
  const menu = (label: string, icon: IconName) => { const definition = menus.find(m => m.label === label); return definition && <MenuBar key={label} menus={[definition]} onAction={onAction} toolbarIcon={<Icon name={icon}/>}/>; };
  return <div className="toolbar" aria-label="Werkzeugleiste">
    {button("Session", "ssh", "newSession", "Neue Sitzung")}{menu("Sessions", "star")}
    {button("Lokales Terminal", "terminal", "local", shellName)}{hasWsl && button("WSL", "tux", "wsl")}
    {menu("Tools", "tools")}{menu("View", "view")}{menu("Split", "split")}
    {button("MultiExec", "terminal", "multiexec")}{button("Settings", "settings", "settings")}{menu("Help", "help")}
    {button("Macros", "macros", "macros", "Makros folgen", true)}<div className="toolbar-spacer"/>{button("Beenden", "power", "quit")}
  </div>;
}
