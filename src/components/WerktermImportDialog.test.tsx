import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { WerktermImportDialog } from "./WerktermImportDialog";
const host = vi.hoisted(() => ({ values: [] as unknown[], index: 0, preview: vi.fn(), commit: vi.fn() }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(), useId: () => "import", useEffect: vi.fn(),
  useState: (initial: unknown) => {
    const index = host.index++;
    if (!(index in host.values)) host.values[index] = typeof initial === "function" ? initial() : initial;
    return [host.values[index], (value: unknown) => { host.values[index] = typeof value === "function" ? value(host.values[index]) : value; }];
  },
}));
vi.mock("./useModal", () => ({ useModal: () => ({ current: null }) }));
vi.mock("../lib/sessions", async importOriginal => ({ ...await importOriginal<typeof import("../lib/sessions")>(), previewWerktermImport: host.preview, importWerktermSessions: host.commit }));
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as ReactNode)] : []);
}
const imported = vi.fn();
function render() { host.index = 0; return WerktermImportDialog({ onClose() {}, onImported: imported }); }
async function submit() {
  const form = elements(render()).find(item => item.type === "form")!;
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  await vi.waitFor(() => expect(host.values[3]).toBe(false));
}
beforeEach(() => { host.values = ["sessions.json"]; vi.clearAllMocks(); });
it("deselects duplicates by default and imports only selected file ids", async () => {
  const session = { kind: "ssh", name: "Server", folder: "Work", host: "server", port: 22, user: null, auth: { type: "ask" }, source: null };
  host.preview.mockResolvedValue({ sessions: [{ ...session, id: "a" }, { ...session, id: "b" }], duplicateOf: [null, "local"], warnings: ["Hinweis"] });
  await submit();
  const checkboxes = elements(render()).filter(item => item.type === "input" && item.props.type === "checkbox");
  expect(checkboxes.map(item => item.props.checked)).toEqual([true, false]);
  const result = { imported: 1, skippedDuplicates: 0, warnings: [] };
  host.commit.mockResolvedValue(result);
  await submit();
  expect(host.commit).toHaveBeenCalledWith("sessions.json", ["a"]);
  expect(imported).toHaveBeenCalledWith(result);
});
it("retains the file step when preview loading fails", async () => {
  host.preview.mockRejectedValue("Keine Werkterm-Sitzungsdatei");
  await submit();
  expect(host.values[1]).toBe(null); expect(host.values[4]).toBe("Keine Werkterm-Sitzungsdatei");
  expect(imported).not.toHaveBeenCalled();
});
