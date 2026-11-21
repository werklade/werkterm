import { Channel, invoke } from "@tauri-apps/api/core";

import type { TransferProgress } from "./transferFormat";
import type { TreeListing } from "./transferQueue";
export { localFileName, transferText, type TransferProgress } from "./transferFormat";
export interface TransferStatus { text: string; cancel: () => void }
let nextTransferId = 1;
export const allocateTransferId = () => nextTransferId++;
export const cancelTransfer = (transferId: number) => invoke<void>("ssh_cancel_transfer", { transferId });
export const downloadFile = (id: number, remotePath: string, localPath: string, overwrite: boolean, transferId: number, onProgress: Channel<TransferProgress>) =>
  invoke<void>("ssh_download", { id, remotePath, localPath, overwrite, transferId, onProgress });
export const uploadFile = (id: number, localPath: string, remoteDir: string, overwrite: boolean, transferId: number, onProgress: Channel<TransferProgress>) =>
  invoke<void>("ssh_upload", { id, localPath, remoteDir, overwrite, transferId, onProgress });
export const listRemoteTree = (id: number, path: string, transferId: number) => invoke<TreeListing>("ssh_list_tree", { id, path, transferId });
export const listLocalTree = (path: string, transferId: number) => invoke<TreeListing>("local_list_tree", { path, transferId });
export const ensureRemoteDir = (id: number, path: string) => invoke<void>("ssh_ensure_dir", { id, path });
export const ensureLocalDir = (path: string) => invoke<void>("local_ensure_dir", { path });
export const makeDirectory = (id: number, parent: string, name: string) => invoke<void>("ssh_mkdir", { id, parent, name });
export const createFile = (id: number, parent: string, name: string) => invoke<void>("ssh_create_file", { id, parent, name });
export const renameEntry = (id: number, parent: string, name: string, newName: string) => invoke<void>("ssh_rename", { id, parent, name, newName });
export const countEntries = (id: number, path: string) => invoke<number>("ssh_count_entries", { id, path });
export const deleteEntry = (id: number, path: string, recursive: boolean) => invoke<void>("ssh_delete", { id, path, recursive });
export const validRemoteName = (name: string) => name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
export const remoteChild = (parent: string, name: string) => `${parent.replace(/\/+$/, "")}/${name}`;
