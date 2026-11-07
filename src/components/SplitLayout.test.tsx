import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { paneStyle, SplitLayout } from "./SplitLayout";

it("positions both orientations and all four quadrants", () => {
  expect(paneStyle("columns", 1, 60, 40)).toMatchObject({ left: "60%", top: 0, width: "40%", height: "100%" });
  expect(paneStyle("rows", 1, 60, 40)).toMatchObject({ left: 0, top: "40%", width: "100%", height: "60%" });
  expect(paneStyle("quad", 3, 60, 40)).toMatchObject({ left: "60%", top: "40%", width: "40%", height: "60%" });
  expect(paneStyle("single", 0, 60, 40)).toMatchObject({ width: "100%", height: "100%" });
});
it("renders terminal selectors, an empty pane and focus without closing tabs", () => {
  const noop = () => {};
  const html = renderToStaticMarkup(<SplitLayout mode="columns" panes={[1, null]} terminals={[{ id: 1, title: "Shell" }]} focusedIndex={1}
    ratios={{ x: 50, y: 50 }} onRatios={noop} onAssign={noop} onFocus={noop} onNew={noop} />);
  expect(html.match(/<select /g)).toHaveLength(2);
  expect(html).toContain("Neues lokales Terminal");
  expect(html).toContain("Bereich 2 leeren");
  expect(html.match(/split-pane-chrome focused/g)).toHaveLength(1);
  expect(html.match(/role="separator"/g)).toHaveLength(1);
});
