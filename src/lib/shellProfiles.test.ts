import { describe, expect, it } from "vitest";
import type { BrowserTab } from "../components/FileBrowser";
import { terminalDescriptors } from "./history";
import { kindIcon } from "./kindIcon";
import type { ShellProfile } from "./pty";
import { groupProfiles, profileFromAction, profileKind, profileMenuItems, profileMenuLabel, profileTitle, wslDistroFromProfile } from "./shellProfiles";

const profile = (id: string, label: string, isDefault = false): ShellProfile => ({ id, kind: id.startsWith("wsl:") ? "wsl" : "local", label, version: null, isDefault });
const profiles = [profile("pwsh:C:\\Program Files\\PowerShell\\7\\pwsh.exe", "PowerShell 7.4"), profile("powershell", "Windows PowerShell"), profile("cmd", "cmd"), profile("wsl:Ubuntu-24.04", "Ubuntu-24.04", true), profile("wsl:Debian", "Debian")];

describe("shell profiles", () => {
  it("derives the WSL distribution and the tab kind from the profile id", () => {
    expect(wslDistroFromProfile("wsl:Ubuntu-24.04")).toBe("Ubuntu-24.04");
    expect(wslDistroFromProfile("wsl:")).toBeNull();
    expect(wslDistroFromProfile("cmd")).toBeNull();
    expect(wslDistroFromProfile(undefined)).toBeNull();
    expect(profileKind("wsl:Debian")).toBe("wsl");
    expect(profileKind("powershell")).toBe("local");
  });
  it("names tabs and menu entries", () => {
    expect(profileTitle("cmd", profiles)).toBe("Eingabeaufforderung");
    expect(profileTitle("wsl:Debian", profiles)).toBe("WSL: Debian");
    expect(profileTitle("pwsh:C:\\Program Files\\PowerShell\\7\\pwsh.exe", profiles)).toBe("PowerShell 7.4");
    expect(profileTitle("pwsh:gone", [])).toBe("PowerShell");
    expect(profileTitle("powershell", [])).toBe("Windows PowerShell");
    expect(profileMenuLabel(profiles[3])).toBe("WSL: Ubuntu-24.04 (Standard)");
    expect(profileMenuLabel(profiles[4])).toBe("WSL: Debian");
    expect(profileMenuLabel(profiles[2])).toBe("Eingabeaufforderung");
  });
  it("groups PowerShell, Eingabeaufforderung and WSL in backend order", () => {
    const groups = groupProfiles(profiles);
    expect(groups.powershell.map(p => p.id)).toEqual([profiles[0].id, "powershell"]);
    expect(groups.cmd.map(p => p.id)).toEqual(["cmd"]);
    expect(groups.wsl.map(p => p.id)).toEqual(["wsl:Ubuntu-24.04", "wsl:Debian"]);
  });
  it("builds menu entries with one separator before WSL and round-trips the action", () => {
    const items = profileMenuItems(profiles);
    expect(items.map(i => i.separator ? "-" : profileFromAction(i.action))).toEqual([profiles[0].id, "powershell", "cmd", "-", "wsl:Ubuntu-24.04", "wsl:Debian"]);
    expect(profileMenuItems(profiles.slice(0, 3)).some(i => i.separator)).toBe(false);
    expect(profileFromAction("local")).toBeNull();
  });
  it("picks tab icons by profile", () => {
    expect(kindIcon("local", "PowerShell", "pwsh:x")).toBe("powershell");
    expect(kindIcon("local", "", "powershell")).toBe("powershell");
    expect(kindIcon("local", "PowerShell", "cmd")).toBe("terminal");
    expect(kindIcon("wsl", "", "wsl:Debian")).toBe("tux");
  });
});

describe("last tabs with profile", () => {
  const base = { id: 1, title: "x", exited: false, browserPath: "" };
  it("stores the profile only when set", () => {
    const tabs: BrowserTab[] = [{ ...base, kind: "local" }, { ...base, kind: "local", profile: "cmd" }, { ...base, kind: "wsl", profile: "wsl:Debian" }];
    expect(terminalDescriptors(tabs)).toEqual([{ type: "local" }, { type: "local", profile: "cmd" }, { type: "wsl", profile: "wsl:Debian" }]);
  });
});
