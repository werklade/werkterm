import { describe, expect, it } from "vitest";
import { ansiKeys, terminalThemes } from "./terminalThemes";
describe("terminal themes", () => {
  it("defines all 16 ANSI colors and readable foreground/background pairs", () => {
    expect(Object.keys(terminalThemes)).toHaveLength(4);
    expect(ansiKeys).toHaveLength(16);
    for (const theme of Object.values(terminalThemes)) {
      for (const key of [...ansiKeys, "foreground", "background", "cursor"] as const) expect(theme[key]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(theme.foreground).not.toBe(theme.background);
    }
    expect(terminalThemes["Werkterm Dunkel"].background).toBe("#000000");
    expect(terminalThemes.Hell.background).toBe("#ffffff");
  });
});
