import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Home } from "../components/Home";
import { TabBar } from "../components/TabBar";
import { Toolbar } from "../components/Toolbar";
import { createMenus } from "./actions";
import { searchSessions, terminalDescriptors } from "./history";
import { parseQuickConnect } from "./quickConnect";
import { normalizeSettings, defaultSettings } from "./settings";
import { shortcuts } from "./menu";
import type { SavedSession } from "./sessions";
const session: SavedSession = { id: "a", kind: "ssh", name: "Production", host: "server.example", user: "marc", port: 22, folder: "Work/Servers", auth: { type: "ask" }, source: null };
const noop = () => {};
const definitions = (isLinux = false) => createMenus({ savedSessions: [session], settings: defaultSettings, hasWsl: false, activeId: 0, multiExec: true, isLinux });
describe("Home search", () => {
  it("filters case-insensitively by name, host and user", () => {
    for (const query of ["PROD", "example", "Marc", "  server  "]) expect(searchSessions([session], query)).toEqual([session]);
    expect(searchSessions([session], "missing")).toEqual([]);
    expect(searchSessions([session], " ")).toEqual([]);
    expect(searchSessions([{ ...session, user: null }], "marc")).toEqual([]);
  });
  it("recognizes targets with optional user and port and rejects credentials", () => {
    for (const target of ["host", "user@host:2222", "[::1]:22"]) expect(parseQuickConnect(target)).not.toBeNull();
    for (const target of ["user:password@host", "host:65536", "host:0", "ssh://host", "not a host"]) expect(parseQuickConnect(target)).toBeNull();
  });
  it("hides deleted saved recents and disables empty restoration", () => {
    const html = renderToStaticMarkup(<Home sessions={[session]} recents={[{ kind: "saved", sessionId: "deleted", name: "Deleted", at: 0 }, { kind: "saved", sessionId: "a", name: "Old name", at: 1 }]} canRestore={false} onLocal={noop} onRestore={noop} onSaved={noop} onQuick={noop}/>);
    expect(html).not.toContain("Deleted"); expect(html).not.toContain("Old name"); expect(html).toContain("Production");
    expect(html).toContain('disabled=""');
  });
  it("always renders the first Home tab without a close control", () => {
    const html = renderToStaticMarkup(<TabBar tabs={[]} activeId={0} hasWsl={false} onSelect={noop} onClose={noop} onOpen={noop}/>);
    expect(html).toContain('id="tab-home"'); expect(html).toContain('aria-selected="true"'); expect(html).not.toContain('tab-close');
  });
});
describe("View preferences and shared action definitions", () => {
  it("keeps at least one bar configured outside compact mode", () => {
    for (const bars of [null, false, "none", "", {}, "menu", "toolbar", "both"]) {
      const result = normalizeSettings({ bars, compact: false }); expect(["menu", "toolbar", "both"]).toContain(result.bars);
    }
    expect(normalizeSettings({ bars: "toolbar", sidebarRight: true, tabNumbers: true, tabClose: false })).toMatchObject({ bars: "toolbar", sidebarRight: true, tabNumbers: true, tabClose: false });
  });
  it("assigns shortcuts without collisions and uses registered actions", () => {
    const all = definitions().flatMap(m => m.items).filter(i => i.shortcut);
    expect(new Set(all.map(i => i.shortcut)).size).toBe(all.length);
    expect(new Set(all.map(i => i.action)).size).toBe(all.length);
    expect(all.map(i => i.action).sort()).toEqual(shortcuts.map(i => i.action).sort());
  });
  it("groups sessions and restricts system tools to Linux", () => {
    expect(definitions().find(m => m.label === "Sessions")?.items[0]).toMatchObject({ label: "Work/Servers", heading: true });
    expect(definitions().flatMap(m => m.items).some(i => i.action === "root")).toBe(false);
    expect(definitions(true).flatMap(m => m.items).some(i => i.action === "root")).toBe(true);
    expect(definitions().find(m => m.label === "Split")?.items.filter(i => !i.disabled).map(i => i.action)).toEqual(["single"]);
  });
  it("renders toolbar order, pressed state, placeholders and shell tooltip", () => {
    const html = renderToStaticMarkup(<Toolbar hasWsl={false} menus={definitions()} shellName="zsh" multiExec={true} onAction={noop}/>);
    const labels = ["Session", "Sessions", "Lokales Terminal", "Tools", "View", "Split", "MultiExec", "Settings", "Help", "Macros", "Beenden"];
    const positions = labels.map(label => html.indexOf(`>${label}</span>`));
    expect(positions.every(i => i >= 0)).toBe(true); expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain('title="zsh"'); expect(html).toContain('aria-pressed="true"'); expect(html).toContain('title="Makros folgen" disabled=""');
  });
});

it("serializes terminal order without editor or runtime data", () => {
  const base = { id: 7, title: "Private title", exited: false, browserPath: "/private", sessionId: 123 };
  const descriptors = terminalDescriptors([
    { ...base, kind: "local", startCommand: "root" },
    { ...base, kind: "editor" }, { ...base, kind: "wsl" },
    { ...base, kind: "ssh", savedSessionId: "id", target: "u@host" },
    { ...base, kind: "ssh", target: "other@host:2222" },
  ]);
  expect(JSON.stringify(descriptors)).toBe('[{"type":"local"},{"type":"wsl"},{"type":"saved","sessionId":"id"},{"type":"quick","target":"other@host:2222"}]');
});
