import { useSyncExternalStore } from "react";
import { getIconSnapshot, subscribeIcons, iconSvg } from "../lib/iconSets";
import debianIcon from "../assets/icons/debian.svg?raw";
import telnetIcon from "../assets/icons/telnet.svg?raw";
import serialIcon from "../assets/icons/serial.svg?raw";
import powershellIcon from "../assets/icons/powershell.svg?raw";
import jumpIcon from "../assets/icons/jump.svg?raw";
import icon0 from "../assets/icons/terminal.svg?raw";
import icon1 from "../assets/icons/tux.svg?raw";
import icon2 from "../assets/icons/star.svg?raw";
import icon3 from "../assets/icons/tools.svg?raw";
import icon4 from "../assets/icons/macros.svg?raw";
import icon5 from "../assets/icons/globe.svg?raw";
import icon6 from "../assets/icons/folder-up.svg?raw";
import icon7 from "../assets/icons/download.svg?raw";
import icon8 from "../assets/icons/upload.svg?raw";
import icon9 from "../assets/icons/refresh.svg?raw";
import icon10 from "../assets/icons/folder-new.svg?raw";
import icon11 from "../assets/icons/file-new.svg?raw";
import icon12 from "../assets/icons/delete.svg?raw";
import icon13 from "../assets/icons/permissions.svg?raw";
import icon14 from "../assets/icons/edit.svg?raw";
import renameIcon from "../assets/icons/rename.svg?raw";
import folderIcon from "../assets/icons/folder.svg?raw";
import fileIcon from "../assets/icons/file.svg?raw";

import saveIcon from "../assets/icons/save.svg?raw";
import undoIcon from "../assets/icons/undo.svg?raw";
import redoIcon from "../assets/icons/redo.svg?raw";
import searchIcon from "../assets/icons/search.svg?raw";
import wrapIcon from "../assets/icons/wrap.svg?raw";
import sshIcon from "../assets/icons/ssh.svg?raw";
import windowsIcon from "../assets/icons/windows.svg?raw";
import appleIcon from "../assets/icons/apple.svg?raw";
import sessionNewIcon from "../assets/icons/session-new.svg?raw";
import settingsIcon from "../assets/icons/settings.svg?raw";
import homeIcon from "../assets/icons/home.svg?raw";
import multiexecIcon from "../assets/icons/multiexec.svg?raw";
import helpIcon from "../assets/icons/help.svg?raw";
import splitIcon from "../assets/icons/split.svg?raw";
import viewIcon from "../assets/icons/view.svg?raw";
import powerIcon from "../assets/icons/power.svg?raw";

export const standardIcons = {
  debian: debianIcon,
  telnet: telnetIcon,
  serial: serialIcon,
  powershell: powershellIcon,
  jump: jumpIcon,

  home: homeIcon,
  settings: settingsIcon,
  "session-new": sessionNewIcon,
  multiexec: multiexecIcon,
  help: helpIcon,
  split: splitIcon,
  view: viewIcon,
  power: powerIcon,
  "save": saveIcon,
  "undo": undoIcon,
  "redo": redoIcon,
  "search": searchIcon,
  "wrap": wrapIcon,
  "ssh": sshIcon,
  "windows": windowsIcon,
  "apple": appleIcon,
  "terminal": icon0,
  "tux": icon1,
  "star": icon2,
  "tools": icon3,
  "macros": icon4,
  "globe": icon5,
  "folder-up": icon6,
  "download": icon7,
  "upload": icon8,
  "refresh": icon9,
  "folder-new": icon10,
  "file-new": icon11,
  "delete": icon12,
  "permissions": icon13,
  "edit": icon14,
  "rename": renameIcon,
  "folder": folderIcon,
  "file": fileIcon,
};
export type IconName = keyof typeof standardIcons;
export function Icon({ name }: { name: IconName }) {
  const set = useSyncExternalStore(subscribeIcons, getIconSnapshot, getIconSnapshot);
  return <span className="icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconSvg(set, name, standardIcons) }} />;
}
