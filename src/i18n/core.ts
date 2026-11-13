// React-free part of the i18n module. Test setup imports only this file, so loading it
// does not bind the real "react" before a test file replaces it with vi.mock("react").
import de from "./de.json";
import en from "./en.json";

export type Language = "de" | "en";
export type LanguageSetting = "system" | Language;
/** German is the source of truth: every key must exist in de.json. */
export type TextKey = keyof typeof de;
/** Prefixes that have both a `.one` and an `.other` entry. */
export type PluralKey = { [K in TextKey]: K extends `${infer P}.one` ? P : never }[TextKey];
type Params = Record<string, string | number>;

const messages: Record<Language, Record<string, string>> = { de, en };
const listeners = new Set<() => void>();
let language: Language = "de";

/** "system" follows the OS/webview locale; anything that is not English falls back to German. */
export function resolveLanguage(setting: LanguageSetting, systemLocale: string | undefined = globalThis.navigator?.language): Language {
  if (setting !== "system") return setting;
  return (systemLocale ?? "").toLowerCase().startsWith("en") ? "en" : "de";
}

export const getLanguage = (): Language => language;
export function setLanguage(next: Language): void {
  if (typeof document !== "undefined") document.documentElement.lang = next;
  if (next === language) return;
  language = next;
  listeners.forEach(listener => listener());
}
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const fill = (text: string, params?: Params): string =>
  params ? text.replace(/\{(\w+)\}/g, (match, name: string) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match) : text;
const lookup = (key: string): string => messages[language][key] ?? messages.de[key] ?? key;

export function t(key: TextKey, params?: Params): string { return fill(lookup(key), params); }
/** Plural form via `${key}.one` / `${key}.other`; `{count}` is filled in automatically, formatted for the locale. */
export function tp(key: PluralKey, count: number, params?: Params): string {
  const category = new Intl.PluralRules(currentLocale()).select(count);
  const full = `${key}.${category === "one" ? "one" : "other"}`;
  return fill(lookup(full), { ...params, count: count.toLocaleString(currentLocale()) });
}

export const currentLocale = (): string => language === "en" ? "en-US" : "de-DE";
