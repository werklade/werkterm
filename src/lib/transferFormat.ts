import { currentLocale, t, type TextKey } from "../i18n";
export interface TransferProgress { transferId: number; done: number; total: number | null }

export const localFileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

const knownCodes = new Set(["SUDO_DENIED", "SUDO_PASSWORD", "SUDO_NO_SFTP", "SUDO_FAILED", "EXISTS", "DIRECTORY", "CANCELLED"]);
/** Backend errors arrive as "CODE" or "CODE: German text". Known codes become localized texts, other SUDO_* codes lose their prefix, anything else stays unchanged. */
export function backendErrorText(reason: unknown): string {
  const text = String(reason);
  const match = /^([A-Z][A-Z_]*)(?::\s*([\s\S]*))?$/.exec(text);
  if (!match) return text;
  const [, code, detail] = match;
  if (knownCodes.has(code)) return t(`error.${code}` as TextKey, { name: detail ?? "" });
  return code.startsWith("SUDO_") && detail !== undefined ? detail : text;
}

export function transferText(direction: "↑" | "↓", name: string, progress: TransferProgress): string {
  const bytes = (value: number) => `${(value / 1_000_000).toLocaleString(currentLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  const percent = progress.total === null ? "" : `${progress.total === 0 ? 100 : Math.min(100, Math.floor(progress.done / progress.total * 100))} % `;
  return `${direction} ${name} ${percent}(${bytes(progress.done)}${progress.total === null ? "" : ` / ${bytes(progress.total)}`})`;
}
