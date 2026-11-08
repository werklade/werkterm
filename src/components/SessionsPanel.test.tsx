import { afterAll, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionsPanel } from "./SessionsPanel";
import type { SavedSession } from "../lib/sessions";

const host = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
  useState: (initial: unknown) => {
    const value = typeof initial === "function" ? initial() : initial;
    return [value && typeof value === "object" && "ids" in value ? { ids: host.ids, anchor: "" } : value, vi.fn()];
  },
}));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
afterAll(() => vi.unstubAllGlobals());
const sessions: SavedSession[] = ["one", "two"].map(id => ({
  kind: "ssh", id, name: id, folder: "", host: "example.test", port: 22,
  user: null, auth: { type: "default" }, source: null,
}));
it.each([0, 1, 2])("shows the selection count only for multiple sessions (%s)", count => {
  host.ids = sessions.slice(0, count).map(session => session.id);
  const noop = () => {};
  const html = renderToStaticMarkup(<SessionsPanel sessions={sessions} onConnect={noop} onEdit={noop} onReload={noop} onStatus={noop} />);
  expect(html.includes("ausgewählt")).toBe(count >= 2);
  expect(html).toContain('aria-label="Importieren"');
  expect(html).not.toContain(">Importieren</button>");
});
