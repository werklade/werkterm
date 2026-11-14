import { currentLocale } from "../i18n";
import { errorText } from "./backendError";
export interface TransferProgress { transferId: number; done: number; total: number | null }

export const localFileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Kept for existing callers; see errorText. */
export const backendErrorText = (reason: unknown): string => errorText(reason);

export function transferText(direction: "↑" | "↓", name: string, progress: TransferProgress): string {
  const bytes = (value: number) => `${(value / 1_000_000).toLocaleString(currentLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  const percent = progress.total === null ? "" : `${progress.total === 0 ? 100 : Math.min(100, Math.floor(progress.done / progress.total * 100))} % `;
  return `${direction} ${name} ${percent}(${bytes(progress.done)}${progress.total === null ? "" : ` / ${bytes(progress.total)}`})`;
}
