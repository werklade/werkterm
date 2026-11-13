import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { t } from "../i18n";

const unavailable = () => new Error(t("clipboard.unavailable"));

export async function readClipboardText(): Promise<string> {
  try { return await readText(); } catch { throw unavailable(); }
}

export async function writeClipboardText(text: string): Promise<void> {
  try { await writeText(text); } catch { throw unavailable(); }
}
