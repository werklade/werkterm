import { Channel, invoke } from "@tauri-apps/api/core";

export interface TransferProgress { transferId: number; done: number; total: number | null }
export interface TransferStatus { text: string; cancel: () => void }
let nextTransferId = 1;
export const allocateTransferId = () => nextTransferId++;
export const cancelTransfer = (transferId: number) => invoke<void>("ssh_cancel_transfer", { transferId });
export const downloadFile = (id: number, remotePath: string, localPath: string, transferId: number, onProgress: Channel<TransferProgress>) =>
  invoke<void>("ssh_download", { id, remotePath, localPath, transferId, onProgress });
export const uploadFile = (id: number, localPath: string, remoteDir: string, overwrite: boolean, transferId: number, onProgress: Channel<TransferProgress>) =>
  invoke<void>("ssh_upload", { id, localPath, remoteDir, overwrite, transferId, onProgress });
export const makeDirectory = (id: number, parent: string, name: string) => invoke<void>("ssh_mkdir", { id, parent, name });
export const createFile = (id: number, parent: string, name: string) => invoke<void>("ssh_create_file", { id, parent, name });
export const countEntries = (id: number, path: string) => invoke<number>("ssh_count_entries", { id, path });
export const deleteEntry = (id: number, path: string, recursive: boolean) => invoke<void>("ssh_delete", { id, path, recursive });
export const validRemoteName = (name: string) => name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
export const localFileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
export const remoteChild = (parent: string, name: string) => `${parent.replace(/\/+$/, "")}/${name}`;
export function transferText(direction: "↑" | "↓", name: string, progress: TransferProgress): string {
  const bytes = (value: number) => `${(value / 1_000_000).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  const percent = progress.total === null ? "" : `${progress.total === 0 ? 100 : Math.min(100, Math.floor(progress.done / progress.total * 100))} % `;
  return `${direction} ${name} ${percent}(${bytes(progress.done)}${progress.total === null ? "" : ` / ${bytes(progress.total)}`})`;
}
