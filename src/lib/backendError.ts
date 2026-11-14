import { currentLocale, hasText, t, type TextKey } from "../i18n";

/** Parsed backend error. `text` is the free text of a legacy "CODE: Text" error. */
export interface BackendError { code: string; args: Record<string, string>; detail?: string; text?: string }

const codePattern = /^([A-Z][A-Z0-9_]+)(?::\s*([\s\S]*))?$/;

const messageOf = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);

/** Wire format: "CODE", "CODE: {json with args/detail}" or legacy "CODE: free text". Plain text → null. */
export function parseBackendError(reason: unknown): BackendError | null {
  const match = codePattern.exec(messageOf(reason));
  if (!match) return null;
  const [, code, rest] = match;
  if (rest === undefined) return { code, args: {} };
  if (rest.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(rest);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const { args, detail } = value as { args?: unknown; detail?: unknown };
        const parsed: BackendError = { code, args: {} };
        if (args && typeof args === "object" && !Array.isArray(args))
          for (const [name, arg] of Object.entries(args)) parsed.args[name] = String(arg);
        if (typeof detail === "string") parsed.detail = detail;
        return parsed;
      }
    } catch { /* Not JSON: treated as legacy free text. */ }
  }
  return { code, args: {}, text: rest };
}

/** Code of a backend error, or undefined for plain text. */
export const errorCode = (reason: unknown): string | undefined => parseBackendError(reason)?.code;

/** Key for the code: `error.<CODE>`, or the plural form `error.<CODE>.one|.other` chosen by the `count` arg. */
function messageKey(code: string, args: Record<string, string>): string | null {
  const key = `error.${code}`;
  if (hasText(key)) return key;
  const count = Number(args.count);
  if (!hasText(`${key}.one`) || !hasText(`${key}.other`) || args.count === undefined || !Number.isFinite(count)) return null;
  return `${key}.${new Intl.PluralRules(currentLocale()).select(count) === "one" ? "one" : "other"}`;
}

/** Nested backend errors: arg `error` is one wire-format error, arg `errors` a JSON array of them. */
function translatedArgs(args: Record<string, string>): Record<string, string> {
  const result = { ...args };
  if ("error" in args) result.error = errorText(args.error);
  if ("errors" in args) {
    try {
      const list: unknown = JSON.parse(args.errors);
      if (Array.isArray(list)) result.errors = list.map(entry => errorText(String(entry))).join("; ");
    } catch { /* Not a list: shown unchanged. */ }
  }
  return result;
}

/** Translated text for a backend error (+ ": detail"). Legacy free text, plain text and unknown codes stay unchanged. */
export function errorText(reason: unknown): string {
  const parsed = parseBackendError(reason);
  if (!parsed) return messageOf(reason);
  const key = messageKey(parsed.code, parsed.args);
  if (!key) return messageOf(reason);
  if (parsed.text !== undefined) return parsed.text || t(key as TextKey);
  const text = t(key as TextKey, translatedArgs(parsed.args));
  return parsed.detail ? `${text}: ${parsed.detail}` : text;
}
