import { describe, expect, it } from "vitest";
import tokens from "./werklade.tokens.json";
import { builtInDesigns, editorTokens, uiTokens } from "../lib/designs";
import { ansiKeys } from "../lib/terminalThemes";

const hex = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const terminalKeys = ["background", "foreground", "cursor", "selectionBackground", ...ansiKeys];

// The designs are built from the tokens, so check the token file itself is complete and valid.
describe("werklade/design tokens are complete", () => {
  for (const id of ["dark", "light"] as const) {
    it(id, () => {
      const theme = tokens.themes[id] as { ui: Record<string, string>; terminal: Record<string, string>; editor: Record<string, string> };
      for (const [group, keys] of [["ui", uiTokens], ["terminal", terminalKeys], ["editor", editorTokens]] as const) {
        expect(Object.keys(theme[group]).sort(), group).toEqual([...keys].sort());
        for (const [key, value] of Object.entries(theme[group])) expect(value, `${group}.${key}`).toMatch(hex);
      }
    });
  }
});

// The Werklade designs must match werklade/design; update via `npm run sync-design`.
describe("Werklade designs match werklade/design tokens", () => {
  for (const [id, name] of [["dark", "Werklade Dunkel"], ["light", "Werklade Hell"]] as const) {
    it(name, () => {
      const theme = tokens.themes[id];
      const design = builtInDesigns[name];
      expect(theme.name).toBe(name);
      expect(design.ui).toEqual(theme.ui);
      expect(design.terminal).toEqual(theme.terminal);
      expect(design.editor).toEqual(theme.editor);
    });
  }
});
