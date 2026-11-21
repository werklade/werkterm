import { afterEach, describe, expect, it, vi } from "vitest";
import de from "./de.json";
import en from "./en.json";
import { currentLocale, getLanguage, resolveLanguage, setLanguage, subscribe, t, tp, type TextKey } from "./index";
import { createMenus, menuMnemonics } from "../lib/actions";
import { defaultSettings } from "../lib/settings";
import { shortcutList } from "../lib/menu";

const deText = de as Record<string, string>;
const enText = en as Record<string, string>;
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

afterEach(() => { vi.unstubAllGlobals(); setLanguage("de"); });

describe("message catalogs", () => {
  it("uses session wording for remembered paste choices", () => {
    for (const language of ["de", "en"] as const) {
      setLanguage(language);
      expect(t("paste.rememberProfile")).toBe(language === "de" ? "Für diese Sitzung merken" : "Remember for this session");
      expect(t("paste.rememberNoProfile")).toBe(language === "de" ? "Für diese Sitzung merken (keine gespeicherte Sitzung)" : "Remember for this session (no saved session)");
      expect(tp("paste.profiles", 1)).toBe(language === "de" ? "1 Sitzung" : "1 session");
      expect(tp("paste.profiles", 2)).toBe(language === "de" ? "2 Sitzungen" : "2 sessions");
      const catalog = language === "de" ? deText : enText;
      for (const [key, value] of Object.entries(catalog)) {
        if (key.startsWith("paste.")) expect(value, key).not.toMatch(/profil/i);
      }
    }
  });
  it("have identical key sets", () => {
    expect(Object.keys(enText).sort()).toEqual(Object.keys(deText).sort());
  });
  it("contain no empty values", () => {
    for (const [name, catalog] of [["de", deText], ["en", enText]] as const) {
      for (const [key, value] of Object.entries(catalog)) expect(value.trim(), `${name}:${key}`).not.toBe("");
    }
  });
  it("use the same placeholders per key", () => {
    for (const key of Object.keys(deText)) expect(placeholders(enText[key] ?? ""), key).toEqual(placeholders(deText[key]));
  });
  it("follow the German style rules", () => {
    for (const [key, value] of Object.entries(deText)) {
      expect(value, key).not.toMatch(/\bbitte\b/i);
      expect(value, key).not.toContain("!");
      expect(value, key).not.toMatch(/\b(du|dein\w*|Sie|Ihr\w*)\b/);
    }
  });
  it("follow the English style rules", () => {
    for (const [key, value] of Object.entries(enText)) expect(value, key).not.toContain("!");
  });
  it("define both plural forms for every plural prefix", () => {
    for (const catalog of [deText, enText]) {
      const prefixes = Object.keys(catalog).filter(key => /\.(one|other)$/.test(key)).map(key => key.replace(/\.(one|other)$/, ""));
      for (const prefix of prefixes) { expect(catalog, prefix).toHaveProperty([`${prefix}.one`]); expect(catalog, prefix).toHaveProperty([`${prefix}.other`]); }
    }
  });
});

describe("keys used in source", () => {
  it("all exist in de.json", () => {
    const files = import.meta.glob("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const missing: string[] = [];
    let checked = 0;
    for (const [path, source] of Object.entries(files)) {
      if (/\.test\.tsx?$/.test(path) || path.startsWith("/src/test/")) continue;
      for (const match of source.matchAll(/\b(t|tp)\(\s*"([^"]+)"/g)) {
        checked++;
        const [, fn, key] = match;
        const keys = fn === "tp" ? [`${key}.one`, `${key}.other`] : [key];
        for (const full of keys) if (!(full in deText)) missing.push(`${path}: ${full}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

describe("resolveLanguage", () => {
  it("maps the system locale and falls back to German", () => {
    expect(resolveLanguage("system", "en-US")).toBe("en");
    expect(resolveLanguage("system", "en")).toBe("en");
    expect(resolveLanguage("system", "de-AT")).toBe("de");
    expect(resolveLanguage("system", "fr")).toBe("de");
    expect(resolveLanguage("system", "")).toBe("de");
  });
  it("falls back to German without a navigator", () => {
    vi.stubGlobal("navigator", undefined);
    expect(resolveLanguage("system")).toBe("de");
    expect(resolveLanguage("system", undefined)).toBe("de");
  });
  it("reads navigator.language by default", () => {
    vi.stubGlobal("navigator", { language: "en-GB" });
    expect(resolveLanguage("system")).toBe("en");
  });
  it("ignores the system locale for explicit settings", () => {
    expect(resolveLanguage("en", "de-DE")).toBe("en");
    expect(resolveLanguage("de", "en-US")).toBe("de");
  });
});

describe("t and tp", () => {
  it("translates, switches language and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    expect(t("menu.edit")).toBe("Bearbeiten");
    setLanguage("en");
    expect(getLanguage()).toBe("en");
    expect(currentLocale()).toBe("en-US");
    expect(t("menu.edit")).toBe("Edit");
    setLanguage("en");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setLanguage("de");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(currentLocale()).toBe("de-DE");
  });
  it("interpolates placeholders and keeps unknown ones", () => {
    expect(t("menu.help.updatesAvailable", { version: "0.4.0" })).toBe("Nach Updates suchen… (Version 0.4.0 verfügbar)");
    setLanguage("en");
    expect(t("menu.help.updatesAvailable", { version: "0.4.0" })).toBe("Check for updates… (version 0.4.0 available)");
    expect(t("menu.help.updatesAvailable")).toContain("{version}");
  });
  it("falls back to the key for unknown keys", () => {
    expect(t("does.not.exist" as TextKey)).toBe("does.not.exist");
  });
  it("selects plural forms", () => {
    expect(tp("unit.day", 1)).toBe("1 Tag");
    expect(tp("unit.day", 2)).toBe("2 Tage");
    setLanguage("en");
    expect(tp("unit.day", 1)).toBe("1 day");
    expect(tp("unit.day", 0)).toBe("0 days");
    expect(tp("unit.day", 5)).toBe("5 days");
  });
});

describe("top-level menus", () => {
  const menus = () => createMenus({ savedSessions: [], settings: defaultSettings, hasWsl: false, activeId: 1, multiExec: false, isLinux: true });
  it("have stable ids in the same order for every language", () => {
    const ids = ["edit", "terminal", "sessions", "macros", "view", "split", "tools", "settings", "help"];
    for (const language of ["de", "en"] as const) { setLanguage(language); expect(menus().map(menu => menu.id)).toEqual(ids); }
  });
  it("use a unique mnemonic letter per language", () => {
    for (const language of ["de", "en"] as const) {
      setLanguage(language);
      const letters = menus().map(menu => menu.label[menu.mnemonic]?.toLowerCase());
      expect(letters.every(letter => !!letter), language).toBe(true);
      expect(new Set(letters).size, `${language}: ${letters.join("")}`).toBe(letters.length);
      expect(Object.keys(menuMnemonics[language]).length).toBe(letters.length);
    }
  });
  it("translate displayed shortcuts but keep them distinct", () => {
    setLanguage("en");
    const shortcuts = menus().flatMap(menu => menu.items).map(item => item.shortcut).filter(Boolean);
    expect(shortcuts).toContain("Ctrl+Shift+T");
    expect(shortcuts.some(shortcut => /Strg|Umschalt/.test(shortcut!))).toBe(false);
    setLanguage("de");
    expect(menus().flatMap(menu => menu.items).map(item => item.shortcut)).toContain("Strg+Umschalt+T");
  });
  it("assign shortcuts without collisions in every language", () => {
    for (const language of ["de", "en"] as const) {
      setLanguage(language);
      const all = menus().flatMap(menu => menu.items).filter(item => item.shortcut);
      expect(new Set(all.map(item => item.shortcut)).size, language).toBe(all.length);
      expect(new Set(all.map(item => item.action)).size, language).toBe(all.length);
      const list = shortcutList();
      expect(new Set(list.map(entry => entry.shortcut)).size, language).toBe(list.length);
      expect(all.map(item => item.action).sort(), language).toEqual(list.map(entry => entry.action).sort());
    }
  });
});
