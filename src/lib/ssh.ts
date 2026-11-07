import { Channel, invoke } from "@tauri-apps/api/core";

export type SshPrompt =
  | { type: "hostKey"; requestId: number; host: string; port: number; keyType: string; fingerprint: string }
  | { type: "secret"; requestId: number; kind: "password" | "passphrase"; label: string };

export interface ConnectOptions {
  target: string;
  sessionId?: string | null;
  connectToken: number;
  cols: number;
  rows: number;
  onData: Channel<ArrayBuffer>;
  onExit: Channel<number | null>;
  onPrompt: Channel<SshPrompt>;
}

export const connectSsh = (options: ConnectOptions) => invoke<{ id: number; mode: "SFTP" | "exec" }>("ssh_connect", { ...options, sessionId: options.sessionId ?? null });
export const writeSsh = (id: number, data: string) => invoke<void>("ssh_write", { id, data });
export const resizeSsh = (id: number, cols: number, rows: number) => invoke<void>("ssh_resize", { id, cols, rows });
export const closeSsh = (id: number) => invoke<void>("ssh_close", { id });
export const answerHostKey = (requestId: number, accept: boolean) => invoke<void>("ssh_answer_host_key", { requestId, accept });
export const answerSecret = (requestId: number, secret: string | null) => invoke<void>("ssh_answer_secret", { requestId, secret });

export const cancelSshConnect = (connectToken: number) => invoke<void>("ssh_cancel_connect", { connectToken });
