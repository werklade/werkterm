import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DiffView from "./DiffView";
import { defaultSettings } from "../lib/settings";
import type { DiffPair } from "../lib/diff";

function render(sizes: [number, number]) {
  const pair: DiffPair = {
    sources: [0, 1].map(id => ({ tab: { id, kind: "local", title: "Local", browserPath: "" }, path: `file-${id}` })) as DiffPair["sources"],
    documents: sizes.map((size, docId) => ({ docId, size, name: "file", path: "file", text: "text", bom: false,
      eol: "lf", eolCounts: { lf: 0, crLf: 0, cr: 0 }, mtime: null, readonly: true })) as DiffPair["documents"],
  };
  return renderToStaticMarkup(<DiffView pair={pair} settings={defaultSettings} onOpen={() => {}} />);
}

describe("comparison whitespace toggle", () => {
  it("disables the toggle and explains the limit when either file exceeds one MiB", () => {
    for (const sizes of [[1048577, 1], [1, 1048577]] as [number, number][]) {
      expect(render(sizes)).toContain('<label title="Bei Dateien über 1 MB nicht verfügbar"><input type="checkbox" disabled=""/>Leerzeichen ignorieren</label>');
    }
  });
  it("enables the toggle at the limit", () => {
    expect(render([1048576, 1048576])).toContain('<label><input type="checkbox"/>Leerzeichen ignorieren</label>');
  });
});
