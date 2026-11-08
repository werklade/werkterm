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

const inline = (paths: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
export const standardIcons = {
  debian: debianIcon,
  telnet: telnetIcon,
  serial: serialIcon,
  powershell: powershellIcon,
  jump: jumpIcon,

  home: inline('<path class="wl-fill" stroke="none" d="m3 10 9-7 9 7v10H3z"/><path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>'),
  settings: settingsIcon,
  "session-new": sessionNewIcon,
  multiexec: inline('<rect class="wl-fill" stroke="none" x="8" y="3" width="13" height="11" rx="2"/><rect x="8" y="3" width="13" height="11" rx="2"/><path d="M5 7v8a2 2 0 0 0 2 2h9"/><path d="M2 11v8a2 2 0 0 0 2 2h9"/><path d="m11 7 2 2-2 2"/><path d="M15 11h3"/>'),
  help: inline('<circle class="wl-fill" stroke="none" cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01"/>'),
  split: inline('<path class="wl-fill" stroke="none" d="M5 4h7v16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>'),
  view: inline('<path class="wl-fill" stroke="none" d="M8 9h13v9a2 2 0 0 1-2 2H8z"/><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 9v11"/>'),
  power: inline('<path class="wl-fill" stroke="none" d="M6 5a9 9 0 1 0 12 0z"/><path d="M12 2v10M6 5a9 9 0 1 0 12 0"/>'),
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
  "folder": folderIcon,
  "file": fileIcon,
};
export type IconName = keyof typeof standardIcons;
export function Icon({ name }: { name: IconName }) {
  const set = useSyncExternalStore(subscribeIcons, getIconSnapshot, getIconSnapshot);
  return <span className="icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconSvg(set, name, standardIcons) }} />;
}
