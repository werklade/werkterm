import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  kind: "dir" | "file" | "symlink" | "other";
  size: number;
  permissions: number;
  modified: number | null;
  targetIsDir: boolean;
}

export interface DirListing {
  path: string;
  mode: "sftp" | "exec" | "local";
  entries: DirEntry[];
}

export const listSshDir = (id: number, path: string) => invoke<DirListing>("ssh_list_dir", { id, path });
export const listLocalDir = (path: string, wslDistro: string | null) => invoke<DirListing>("local_list_dir", { path, wslDistro });
