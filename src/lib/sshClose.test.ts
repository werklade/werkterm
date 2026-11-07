import { describe, expect, it } from "vitest";
import { activeSshTabs, shouldConfirmSsh, closeAfterSsh } from "./sshClose";
import { beginClose, advanceClose } from "./editorClose";
import { normalizeSettings } from "./settings";
const tabs = [{ kind: "ssh", exited: false, sessionId: 0 }, { kind: "ssh", exited: true, sessionId: 2 }, { kind: "local", exited: false, sessionId: 3 }, { kind: "wsl", exited: false }, { kind: "ssh", exited: false }, { kind: "editor", exited: false }];
describe("SSH close approval", () => {
  it("counts only connected, live SSH tabs and respects the setting", () => {
    expect(activeSshTabs(tabs)).toEqual([tabs[0]]);
    expect(shouldConfirmSsh(tabs, true)).toBe(true);
    expect(shouldConfirmSsh(tabs, false)).toBe(false);
    expect(shouldConfirmSsh(tabs.slice(1), true)).toBe(false);
    expect(normalizeSettings({}).confirmCloseSsh).toBe(true);
    expect(normalizeSettings({ confirmCloseSsh: false }).confirmCloseSsh).toBe(false);
  });
  it("does not start editor prompts after SSH cancellation", async () => {
    let called = false;
    expect(await closeAfterSsh(async () => false, async () => { called = true; return true; })).toBe(false);
    expect(called).toBe(false);
  });
  it("asks SSH first and preserves editor cancellation", async () => {
    const order: string[] = [];
    expect(await closeAfterSsh(async () => { order.push("ssh"); return true; }, async () => {
      order.push("editor"); return advanceClose(beginClose([1]), "cancel").phase === "done";
    })).toBe(false);
    expect(order).toEqual(["ssh", "editor"]);
    expect(await closeAfterSsh(async () => true, async () => advanceClose(beginClose([1]), "discard").phase === "done")).toBe(true);
  });
});
