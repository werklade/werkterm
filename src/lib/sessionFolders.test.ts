import { describe, expect, it, vi } from "vitest";
import {
  allFolderPaths, buildSessionTree, createSessionFolder, isWithinFolder, joinFolder, listSessionFolders, moveAllowed, movedFolderPath,
  moveSessions, normalizeFolder, parentFolder, removeSessionFolder, renameSessionFolder, restoreSessionLayout, validFolderName,
  type SavedSession,
} from "./sessions";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

const sample = (id: string, folder: string): SavedSession => ({
  kind: "ssh", id, name: id, folder, host: "server.test", port: 22, user: null, auth: { type: "default" }, source: null,
});

describe("session folders", () => {
  it("normalises paths like the backend and compares whole segments", () => {
    expect(normalizeFolder(" Lab // Linux / ")).toBe("Lab/Linux");
    expect(normalizeFolder("/")).toBe("");
    expect(isWithinFolder("Lab/Linux", "Lab")).toBe(true);
    expect(isWithinFolder("Labor", "Lab")).toBe(false);
    expect(isWithinFolder("Lab", "")).toBe(true);
    expect(parentFolder("Lab/Linux")).toBe("Lab");
    expect(parentFolder("Lab")).toBe("");
    expect(joinFolder("", " New ")).toBe("New");
    expect(joinFolder("Lab", "New")).toBe("Lab/New");
    expect(validFolderName(" Name ")).toBe(true);
    for (const name of ["", "  ", "a/b", "tab\there"]) expect(validFolderName(name)).toBe(false);
  });

  it("trims exactly the same characters as the backend", () => {
    expect(normalizeFolder("\uFEFFLab")).toBe("Lab");
    expect(normalizeFolder(" Lab")).toBe("Lab");
    expect(normalizeFolder("\u00A0Lab\u3000/\u2009x\u000B")).toBe("Lab/x");
    // U+0085 is a control character and U+2028 is not Zs: both stay, like in the backend.
    expect(normalizeFolder("\u0085Lab")).toBe("\u0085Lab");
    expect(normalizeFolder("\u2028Lab")).toBe("\u2028Lab");
  });

  it("shows empty folders in the tree next to folders with sessions", () => {
    const tree = buildSessionTree([sample("one", "Lab"), sample("two", "Lab/ Linux ")], ["Archive", "Lab/Empty", "Deep/A/B"]);
    expect(tree.folders.map(folder => folder.path)).toEqual(["Archive", "Deep", "Lab"]);
    const lab = tree.folders[2];
    expect(lab.folders.map(folder => folder.path)).toEqual(["Lab/Empty", "Lab/Linux"]);
    expect(lab.folders[1].sessions.map(session => session.id)).toEqual(["two"]);
    expect(tree.folders[0].sessions).toEqual([]);
    expect(allFolderPaths([sample("one", "Lab")], ["Deep/A"])).toEqual(["Deep", "Deep/A", "Lab"]);
  });

  it("allows drops only where something changes and never into the own subtree", () => {
    const sessions = [sample("one", "Lab"), sample("two", "Lab"), sample("three", "")];
    expect(moveAllowed({ kind: "sessions", ids: ["one", "two"] }, "Lab", sessions)).toBe(false);
    expect(moveAllowed({ kind: "sessions", ids: ["one", "three"] }, "Lab", sessions)).toBe(true);
    expect(moveAllowed({ kind: "sessions", ids: ["one"] }, "", sessions)).toBe(true);
    expect(moveAllowed({ kind: "sessions", ids: ["missing"] }, "", sessions)).toBe(false);
    const folder = { kind: "folder", path: "Lab/Linux" } as const;
    expect(moveAllowed(folder, "Lab/Linux", sessions)).toBe(false);
    expect(moveAllowed(folder, "Lab/Linux/Deep", sessions)).toBe(false);
    expect(moveAllowed(folder, "Lab", sessions)).toBe(false);
    expect(moveAllowed(folder, "", sessions)).toBe(true);
    expect(moveAllowed(folder, "Labor", sessions)).toBe(true);
    expect(movedFolderPath("Lab/Linux", "")).toBe("Linux");
    expect(movedFolderPath("Lab/Linux", "Other")).toBe("Other/Linux");
  });

  it("calls the backend commands with the expected arguments", async () => {
    const undo = { sessions: [{ id: "one", folder: "Lab", expected: "Other" }], added: ["New"], removed: ["Old"] };
    await listSessionFolders();
    await moveSessions(["one", "two"], "Lab");
    await renameSessionFolder("Lab", "Test/Lab");
    await restoreSessionLayout(undo);
    await createSessionFolder("New");
    await removeSessionFolder("New");
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["sessions_folders"],
      ["sessions_move", { ids: ["one", "two"], folder: "Lab" }],
      ["sessions_rename_folder", { from: "Lab", to: "Test/Lab" }],
      ["sessions_restore_layout", { layout: undo }],
      ["sessions_create_folder", { path: "New" }],
      ["sessions_remove_folder", { path: "New" }],
    ]);
  });
});
