import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { Icon, standardIcons, type IconName } from "./Icon";

function elements(svg: string, name: string) {
  const source = `const icon = (${svg});`;
  const parsed = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2020 },
    reportDiagnostics: true,
  });
  expect(parsed.diagnostics, name).toEqual([]);
  const tree = ts.createSourceFile(`${name}.tsx`, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX);
  const result: { tag: string; attributes: Map<string, string>; transformed: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      let transformed = false;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isJsxElement(parent) && parent.openingElement !== node && parent.openingElement.attributes.properties.some(attribute =>
          ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === "transform")) transformed = true;
      }
      result.push({ transformed, tag: node.tagName.getText(tree), attributes: new Map(node.attributes.properties.flatMap(attribute =>
        ts.isJsxAttribute(attribute) && attribute.initializer && ts.isStringLiteral(attribute.initializer)
          ? [[attribute.name.getText(tree), attribute.initializer.text] as const] : [])) });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return result;
}

it("gives every outline icon a tint body and draws stroke-free underlays first", () => {
  for (const [name, svg] of Object.entries(standardIcons)) {
    if (name === "debian") continue; // Fixed brand artwork.
    const nodes = elements(svg, name);
    const tinted = nodes.filter(node => node.attributes.get("class")?.split(/\s+/).includes("wl-fill"));
    expect(tinted.length, name).toBeGreaterThan(0);
    const underlayCounts: Partial<Record<IconName, number>> = {
      home: 1, multiexec: 1, help: 1, split: 1, view: 1, power: 1,
      "session-new": 1, tools: 1, download: 1, upload: 1,
      "folder-new": 1, "folder-up": 1, delete: 1, refresh: 1,
      undo: 1, redo: 1, wrap: 1, jump: 1,
    };
    const drawn = nodes.slice(1).filter(node => node.attributes.get("d")?.replace(/\s/g, "") !== "M00h24v24H0z");
    for (let index = 0; index < (underlayCounts[name as IconName] ?? 0); index++) {
      expect(tinted.includes(drawn[index]), `${name} underlay ${index}`).toBe(true);
      expect(drawn[index].attributes.get("stroke"), `${name} underlay ${index}`).toBe("none");
    }
    let outlineSeen = false;
    for (const node of nodes.slice(1)) {
      const isTint = tinted.includes(node);
      const isBounds = node.attributes.get("d")?.replace(/\s/g, "") === "M00h24v24H0z";
      if (isTint) {
        expect(node.tag, name).not.toBe("svg");
        expect(isBounds, name).toBe(false);
        // Added underlays are identifiable by stroke="none"; existing closed
        // bodies retain their outline. Every underlay precedes visible strokes.
        if (node.attributes.get("stroke") === "none") expect(outlineSeen, name).toBe(false);
      }
      if (!isBounds && node.attributes.get("stroke") !== "none") outlineSeen = true;
    }
  }
});

it("renders Standard icons with every tint body inheriting fill none", () => {
  for (const name of Object.keys(standardIcons) as IconName[]) {
    if (name === "debian") continue;
    const rendered = renderToStaticMarkup(createElement(Icon, { name }));
    expect(rendered, name).not.toContain('data-icons="werklade"');
    const svg = rendered.slice(rendered.indexOf("<svg"), rendered.indexOf("</svg>") + 6);
    const nodes = elements(svg, name);
    expect(nodes[0].attributes.get("fill"), name).toBe("none");
    // Transformed arrow groups explicitly preserve the Standard outline fill.
    for (const group of nodes.filter(node => node.tag === "g")) {
      expect(group.attributes.get("fill"), name).toBe("none");
    }
    for (const node of nodes.filter(node => node.attributes.get("class")?.split(/\s+/).includes("wl-fill"))) {
      expect(node.attributes.has("fill"), name).toBe(false);
      expect(node.attributes.has("style"), name).toBe(false);
    }
  }
});

it("joins new-item outlines to tinted badges and frames open arrow glyphs", () => {
  const badges: IconName[] = ["session-new", "folder-new", "file-new", "folder-up"];
  const arrows: IconName[] = ["refresh", "undo", "redo", "wrap", "jump"];
  for (const name of [...badges, ...arrows]) {
    const nodes = elements(standardIcons[name], name);
    const badge = badges.includes(name);
    const circles = nodes.filter(node => node.tag === "circle"
      && node.attributes.get("cx") === (badge ? "18" : "12")
      && node.attributes.get("cy") === (badge ? "17" : "12")
      && node.attributes.get("r") === (badge ? "4.5" : "9.5"));
    expect(circles, name).toHaveLength(2);
    expect(circles[0].attributes.get("class"), name).toBe("wl-fill");
    expect(circles[0].attributes.get("stroke"), name).toBe("none");
    expect(circles[1].attributes.has("class"), name).toBe(false);
    expect(circles[1].attributes.get("stroke"), name).not.toBe("none");
    if (!badge) {
      const glyphs = nodes.filter(node => node.transformed);
      expect(glyphs.length, name).toBeGreaterThan(0);
      for (const glyph of glyphs) {
        expect(glyph.attributes.get("class")?.split(/\s+/).includes("wl-fill"), name).not.toBe(true);
        expect(glyph.attributes.has("fill"), name).toBe(false);
      }
    }
  }
});
