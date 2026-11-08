import { invoke } from "@tauri-apps/api/core";
import type { BrowserTab } from "../components/FileBrowser";
import type { SavedSession } from "./sessions";
export type Recent = { kind: "saved"; sessionId: string; name: string; at: number } | { kind: "quick"; target: string; at: number };
export type LastTab = { type: "local" | "wsl" } | { type: "saved"; sessionId: string } | { type: "quick"; target: string };
export const recentList = () => invoke<Recent[]>("recent_list");
export const lastTabsList = () => invoke<LastTab[]>("last_tabs_list");
export function searchSessions(items: SavedSession[], query: string): SavedSession[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? items.filter(s => [s.name, s.host, s.serial?.device ?? "", s.user ?? ""].some(value => value.toLocaleLowerCase().includes(needle))) : [];
}

/** Persist only connection descriptors, never runtime IDs, editor contents or authentication. */
export function terminalDescriptors(tabs: readonly BrowserTab[]): LastTab[] {
  return tabs.flatMap((tab): LastTab[] => {
    switch (tab.kind) {
      case "editor": case "diff": case "folderDiff": return [];
      case "local": case "wsl": return [{ type: tab.kind }];
      case "telnet": case "serial": case "ssh": return tab.savedSessionId ? [{ type: "saved", sessionId: tab.savedSessionId }] : [{ type: "quick", target: tab.target ?? "" }];
    }
  });
}
