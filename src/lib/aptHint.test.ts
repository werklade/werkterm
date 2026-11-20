import { describe, expect, it } from "vitest";
import { aptHint, aptSourcesFile, isPlainSemver } from "./aptHint";
import type { InstallKind } from "./updateState";

const deb = (channel: "stable" | "test") => ({ installKind: "deb" as InstallKind, channel });

describe("aptHint", () => {
  it("applies only to deb installs", () => {
    for (const installKind of ["rpm", "other", "appimage", "nsis", "msi"] as InstallKind[]) {
      expect(aptHint({ installKind, channel: "test" }, { version: "1.3.0", downgrade: false })).toBeNull();
      expect(aptHint({ installKind, channel: "stable" }, { version: "1.2.0", downgrade: true })).toBeNull();
    }
  });

  it("keeps the plain upgrade on the stable channel", () => {
    expect(aptHint(deb("stable"), { version: "1.3.0", downgrade: false })).toEqual({ kind: "upgrade" });
  });

  it("test channel: adds the test distribution to the source and installs", () => {
    const hint = aptHint(deb("test"), { version: "1.3.0", downgrade: false });
    expect(hint).toEqual({
      kind: "enableTest",
      steps: [
        { labelKey: "update.apt.step.suites", code: "Suites: stable test" },
        { labelKey: "update.apt.step.refresh", code: "sudo apt update" },
        { labelKey: "update.apt.step.install", code: "sudo apt install werkterm" },
      ],
      command: "grep -q '^Suites:' /etc/apt/sources.list.d/werklade.sources && sudo sed -i 's/^Suites:.*$/Suites: stable test/' /etc/apt/sources.list.d/werklade.sources && sudo apt update && sudo apt install werkterm",
    });
    expect(aptSourcesFile).toBe("/etc/apt/sources.list.d/werklade.sources");
  });

  it("downgrade: removes the test distribution and pins the offered version", () => {
    const hint = aptHint(deb("stable"), { version: "1.2.0", downgrade: true });
    expect(hint).toEqual({
      kind: "leaveTest",
      version: "1.2.0",
      steps: [
        { labelKey: "update.apt.step.suites", code: "Suites: stable" },
        { labelKey: "update.apt.step.refresh", code: "sudo apt update" },
        { labelKey: "update.apt.step.installStable", code: "sudo apt install werkterm=1.2.0" },
      ],
      command: "grep -q '^Suites:' /etc/apt/sources.list.d/werklade.sources && sudo sed -i 's/^Suites:.*$/Suites: stable/' /etc/apt/sources.list.d/werklade.sources && sudo apt update && sudo apt install werkterm=1.2.0",
    });
  });

  it("never puts a version into a command that is not plain SemVer", () => {
    for (const version of ["1.2.0-rc1", "1.2", "01.2.0", "1.2.0+x", "1.2.0;id", "1.2.0 && id", "$(id)", "1.2.0\n", ""]) {
      const hint = aptHint(deb("stable"), { version, downgrade: true });
      expect(hint?.kind).toBe("leaveTest");
      if (hint?.kind !== "leaveTest") continue;
      expect(hint.version).toBeNull();
      expect(hint.command).toBeNull();
      expect(hint.steps.map(step => step.code)).toEqual(["Suites: stable", "sudo apt update"]);
    }
  });

  it("accepts only MAJOR.MINOR.PATCH without leading zeros", () => {
    expect(isPlainSemver("0.0.1")).toBe(true);
    expect(isPlainSemver("10.20.30")).toBe(true);
    expect(isPlainSemver("1.02.0")).toBe(false);
    expect(isPlainSemver(" 1.2.0")).toBe(false);
    expect(isPlainSemver(null)).toBe(false);
  });
});
