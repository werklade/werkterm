import { describe, expect, it } from "vitest";
import tokens from "./werklade.tokens.json";
import { builtInDesigns } from "../lib/designs";

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
