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

const inline = (paths: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const icons = {
  home: inline('<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>'),
  settings: inline('<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>'),
  help: inline('<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01"/>'),
  split: inline('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>'),
  view: inline('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 9v11"/>'),
  power: inline('<path d="M12 2v10M6 5a9 9 0 1 0 12 0"/>'),
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
export type IconName = keyof typeof icons;
export function Icon({ name }: { name: IconName }) {
  return <span className="icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icons[name] }} />;
}
