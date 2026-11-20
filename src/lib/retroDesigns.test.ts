import { describe, expect, it } from "vitest";
import { builtInDesigns, contrastRatio, designColorScheme, designLabel, getDesign } from "./designs";
import { retroDesignDefs } from "./retroDesigns";
import { retroDesignNames } from "./tux/retroSprites";
import de from "../i18n/de.json";
import en from "../i18n/en.json";

describe("retro designs", () => {
  it("are built in, dark only, and match the names the Tux actions look for", () => {
    expect(retroDesignDefs.map(def => def.name)).toEqual(Object.values(retroDesignNames));
    for (const def of retroDesignDefs) {
      expect(builtInDesigns[def.name]).toBeDefined();
      expect(getDesign(def.name).name).toBe(def.name);
      expect(designColorScheme(builtInDesigns[def.name])).toBe("dark");
    }
  });
  it("derive the monitor, hover and editor tokens from their palette", () => {
    const d = builtInDesigns["Retro Gerüst"];
    expect(d.ui["accent-hover-fill"]).toBe(d.ui["accent-hover"]);
    expect(d.ui["monitor-critical"]).toBe(d.ui.danger);
    expect(d.editor.keyword).toBe(d.terminal.magenta);
  });
  it("keep text readable (4.5:1) on the main surfaces", () => {
    for (const def of retroDesignDefs) {
      const { ui, terminal } = builtInDesigns[def.name];
      const pairs: [string, string, string][] = [
        ["terminal", terminal.foreground as string, terminal.background as string],
        ["fg-primary/bg-app", ui["fg-primary"], ui["bg-app"]], ["fg-primary/bg-panel", ui["fg-primary"], ui["bg-panel"]],
        ["fg-secondary/bg-panel", ui["fg-secondary"], ui["bg-panel"]], ["fg-muted/bg-panel", ui["fg-muted"], ui["bg-panel"]],
        ["on-accent/accent", ui["on-accent"], ui.accent], ["accent/bg-app", ui.accent, ui["bg-app"]],
      ];
      for (const [label, fg, bg] of pairs) expect(contrastRatio(fg, bg), `${def.name}: ${label}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("have a translated display name in German and English", () => {
    for (const def of retroDesignDefs) {
      expect(designLabel(def.name)).toBe(def.name);
    }
    for (const key of ["design.name.retroLemminge", "design.name.retroGeruest", "design.name.retroHuepfer"] as const) {
      expect(de[key]).toBeTruthy(); expect(en[key]).toBeTruthy();
    }
  });
});
