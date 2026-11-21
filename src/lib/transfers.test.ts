import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { cancelTransfer, countEntries, createFile, deleteEntry, downloadFile, ensureLocalDir, ensureRemoteDir, listLocalTree, listRemoteTree, localFileName, makeDirectory, remoteChild, transferText, uploadFile, validRemoteName } from "./transfers";
import type { Channel } from "@tauri-apps/api/core";
import type { TransferProgress } from "./transfers";

beforeEach(() => invoke.mockReset());
it.each(["", ".", "..", "a/b", "a\0b"])("rejects an invalid remote name %j", name => {
  expect(validRemoteName(name)).toBe(false);
});
it.each(["file.txt", " spaces ", "a\\b", "äöü"])("preserves a valid POSIX name %j", name => {
  expect(validRemoteName(name)).toBe(true);
});
it("joins remote paths without rewriting backslashes", () => {
  expect(remoteChild("/", "file")).toBe("/file");
  expect(remoteChild("/home/user///", "a\\b")).toBe("/home/user/a\\b");
});
it("extracts local names on both supported platforms", () => {
  expect(localFileName("C:\\Users\\Marc\\file.txt")).toBe("file.txt");
  expect(localFileName("/home/marc/file.txt")).toBe("file.txt");
});
it("formats known, unknown and empty transfer sizes", () => {
  expect(transferText("↓", "datei", { transferId: 1, done: 12_300_000, total: 27_000_000 })).toBe("↓ datei 45 % (12,3 MB / 27,0 MB)");
  expect(transferText("↑", "datei", { transferId: 1, done: 0, total: null })).toBe("↑ datei (0,0 MB)");
  expect(transferText("↑", "leer", { transferId: 1, done: 0, total: 0 })).toBe("↑ leer 100 % (0,0 MB / 0,0 MB)");
});
it("passes camelCase transfer and action parameters to the backend", async () => {
  invoke.mockResolvedValue(undefined);
  const channel = {} as Channel<TransferProgress>;
  await downloadFile(7, "/remote/file", "C:\\file", false, 8, channel);
  expect(invoke).toHaveBeenLastCalledWith("ssh_download", { id: 7, remotePath: "/remote/file", localPath: "C:\\file", overwrite: false, transferId: 8, onProgress: channel });
  await listRemoteTree(7, "/remote/dir", 3);
  expect(invoke).toHaveBeenLastCalledWith("ssh_list_tree", { id: 7, path: "/remote/dir", transferId: 3 });
  await listLocalTree("C:\\dir", 4);
  expect(invoke).toHaveBeenLastCalledWith("local_list_tree", { path: "C:\\dir", transferId: 4 });
  await ensureRemoteDir(7, "/remote/dir");
  expect(invoke).toHaveBeenLastCalledWith("ssh_ensure_dir", { id: 7, path: "/remote/dir" });
  await ensureLocalDir("C:\\dir");
  expect(invoke).toHaveBeenLastCalledWith("local_ensure_dir", { path: "C:\\dir" });
  await uploadFile(7, "/local/file", "/remote", false, 9, channel);
  expect(invoke).toHaveBeenLastCalledWith("ssh_upload", { id: 7, localPath: "/local/file", remoteDir: "/remote", overwrite: false, transferId: 9, onProgress: channel });
  await cancelTransfer(9);
  expect(invoke).toHaveBeenLastCalledWith("ssh_cancel_transfer", { transferId: 9 });
  await makeDirectory(7, "/remote", "new");
  expect(invoke).toHaveBeenLastCalledWith("ssh_mkdir", { id: 7, parent: "/remote", name: "new" });
  await createFile(7, "/remote", "new");
  expect(invoke).toHaveBeenLastCalledWith("ssh_create_file", { id: 7, parent: "/remote", name: "new" });
  await countEntries(7, "/remote/new");
  expect(invoke).toHaveBeenLastCalledWith("ssh_count_entries", { id: 7, path: "/remote/new" });
  await deleteEntry(7, "/remote/link", false);
  expect(invoke).toHaveBeenLastCalledWith("ssh_delete", { id: 7, path: "/remote/link", recursive: false });
});
