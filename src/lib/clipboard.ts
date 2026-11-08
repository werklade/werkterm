import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

const unavailable = () => new Error("Zwischenablage nicht verfügbar");

export async function readClipboardText(): Promise<string> {
  try { return await readText(); } catch { throw unavailable(); }
}

export async function writeClipboardText(text: string): Promise<void> {
  try { await writeText(text); } catch { throw unavailable(); }
}
