import type { TextKey } from "../i18n/core";
import type { AvailableUpdate, UpdateInfo } from "./updateState";

// Pure logic for the update dialog of a .deb install: which apt hint fits the offer and the shell
// commands for it. The app only shows and copies these commands, it never runs them.

/** Source file written by install/werklade-apt-setup.sh and the manual setup in the README. */
export const aptSourcesFile = "/etc/apt/sources.list.d/werklade.sources";
/** Package name in the APT repository. */
export const aptPackage = "werkterm";
export const aptSuitesTest = "Suites: stable test";
export const aptSuitesStable = "Suites: stable";

/** Strict SemVer core (MAJOR.MINOR.PATCH, no leading zeros), the only form Werkterm releases use. */
const semverPattern = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
export const isPlainSemver = (value: unknown): value is string => typeof value === "string" && semverPattern.test(value);

/** One step of the hint: a translated label (i18n key) and the line to type or put into the file. */
export interface AptStep { labelKey: TextKey; code: string }
export type AptHint =
  /** Stable channel, newer stable release: the plain upgrade command. */
  | { kind: "upgrade" }
  /** Test channel, newer version: add the APT distribution "test" to Suites, then install. */
  | { kind: "enableTest"; steps: AptStep[]; command: string }
  /** Back to stable from a newer installed version (test build or withdrawn stable); command is null when the offered version is not plain SemVer. */
  | { kind: "leaveTest"; version: string | null; steps: AptStep[]; command: string | null };

/**
 * Replaces the whole Suites line, so the result does not depend on what was there before. grep first: without a
 * Suites line sed would silently change nothing; the && chain then stops before apt runs.
 */
const setSuites = (line: string) => `grep -q '^Suites:' ${aptSourcesFile} && sudo sed -i 's/^Suites:.*$/${line}/' ${aptSourcesFile}`;
const update = "sudo apt update";

/**
 * Hint for an available update of a .deb install; null for every other install kind (rpm and other installs keep
 * the generic texts). The version only reaches a command after the strict SemVer check.
 */
export function aptHint(info: Pick<UpdateInfo, "installKind" | "channel">, offer: Pick<AvailableUpdate, "version" | "downgrade">): AptHint | null {
  if (info.installKind !== "deb") return null;
  if (offer.downgrade) {
    const version = isPlainSemver(offer.version) ? offer.version : null;
    const install = version ? `sudo apt install ${aptPackage}=${version}` : null;
    const steps: AptStep[] = [
      { labelKey: "update.apt.step.suites", code: aptSuitesStable },
      { labelKey: "update.apt.step.refresh", code: update },
      ...(install ? [{ labelKey: "update.apt.step.installStable" as const, code: install }] : []),
    ];
    return { kind: "leaveTest", version, steps, command: install ? `${setSuites(aptSuitesStable)} && ${update} && ${install}` : null };
  }
  if (info.channel === "test") {
    const install = `sudo apt install ${aptPackage}`;
    return {
      kind: "enableTest",
      steps: [
        { labelKey: "update.apt.step.suites", code: aptSuitesTest },
        { labelKey: "update.apt.step.refresh", code: update },
        { labelKey: "update.apt.step.install", code: install },
      ],
      command: `${setSuites(aptSuitesTest)} && ${update} && ${install}`,
    };
  }
  return { kind: "upgrade" };
}
