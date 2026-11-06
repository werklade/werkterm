import { Channel, invoke } from "@tauri-apps/api/core";

export type SshPrompt =
  | { type: "hostKey"; requestId: number; host: string; port: number; keyType: string; fingerprint: string }
  | { type: "secret"; requestId: number; kind: "password" | "passphrase"; label: string };

export interface ConnectOptions {
  target: string;
  cols: number;
  rows: number;
  onData: Channel<ArrayBuffer>;
  onExit: Channel<number | null>;
  onPrompt: Channel<SshPrompt>;
}

export const connectSsh = (options: ConnectOptions) => invoke<number>("ssh_connect", { ...options });
export const writeSsh = (id: number, data: string) => invoke<void>("ssh_write", { id, data });
export const resizeSsh = (id: number, cols: number, rows: number) => invoke<void>("ssh_resize", { id, cols, rows });
export const closeSsh = (id: number) => invoke<void>("ssh_close", { id });
export const answerHostKey = (requestId: number, accept: boolean) => invoke<void>("ssh_answer_host_key", { requestId, accept });
export const answerSecret = (requestId: number, secret: string | null) => invoke<void>("ssh_answer_secret", { requestId, secret });
