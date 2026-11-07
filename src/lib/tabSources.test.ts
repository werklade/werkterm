import { describe, expect, it } from "vitest";
import type { BrowserTab } from "../components/FileBrowser";
import { browserForEditor, editorFileKey, sourceForEditorOpen } from "./tabSources";

const ssh: BrowserTab = { id: 1, kind: "ssh", title: "SSH", browserPath: "/home", sessionId: 20, exited: false };
const editor: BrowserTab = { id: 2, kind: "editor", title: "one.txt", browserPath: "/etc", exited: false };

describe("editor browser sources", () => {
  it("keeps editor navigation separate from its live terminal source", () => {
    const browser = browserForEditor(editor, ssh, [ssh, editor]);
    expect(browser).toMatchObject({ id: 2, kind: "ssh", browserPath: "/etc", sessionId: 20 });
    expect(ssh.browserPath).toBe("/home");
  });
  it("opens further files against the original source without chaining editor ids", () => {
    const browser = browserForEditor(editor, ssh, [ssh, editor]);
    const source = sourceForEditorOpen(browser, ssh);
    const nextEditor = { ...editor, id: 3, browserPath: "/var" };
    expect(source.id).toBe(ssh.id);
    expect(browserForEditor(nextEditor, source, [ssh, editor, nextEditor])).toMatchObject({ kind: "ssh", sessionId: 20, browserPath: "/var" });
    expect(editorFileKey(source, "/etc/two.txt")).toBe(editorFileKey(ssh, "/etc/two.txt"));
  });
  it("uses current session availability and disables a closed remote source", () => {
    const stopped = { ...ssh, exited: true, sessionId: undefined };
    expect(sourceForEditorOpen(browserForEditor(editor, ssh, [stopped, editor]), ssh)).toMatchObject({ id: 1, exited: true, sessionId: undefined });
    expect(browserForEditor(editor, ssh, [editor])).toMatchObject({ kind: "ssh", exited: true, sessionId: undefined });
  });
  it("retains local and WSL browser context after terminal closure", () => {
    const local = { ...ssh, kind: "local" as const, sessionId: undefined };
    const wsl = { ...local, kind: "wsl" as const, cwd: { host: "Ubuntu", path: "/home" } };
    expect(browserForEditor(editor, local, [editor])).toMatchObject({ kind: "local", exited: false });
    expect(browserForEditor(editor, wsl, [editor])).toMatchObject({ kind: "wsl", exited: false, cwd: { host: "Ubuntu" } });
  });
  it("deduplicates local files across terminals but separates sessions and WSL distributions", () => {
    expect(editorFileKey({ ...ssh, kind: "local" }, "/file")).toBe(editorFileKey({ ...ssh, id: 9, kind: "local" }, "/file"));
    expect(editorFileKey(ssh, "/file")).not.toBe(editorFileKey({ ...ssh, sessionId: 21 }, "/file"));
    expect(editorFileKey({ ...ssh, kind: "wsl", cwd: { host: "Ubuntu", path: "/" } }, "/file")).not.toBe(editorFileKey({ ...ssh, kind: "wsl", cwd: { host: "Debian", path: "/" } }, "/file"));
  });
});
