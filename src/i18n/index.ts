import { useSyncExternalStore } from "react";
import { getLanguage, subscribe, t, type Language } from "./core";

export * from "./core";

export function useLanguage(): Language { return useSyncExternalStore(subscribe, getLanguage, getLanguage); }
/** Returns `t` and re-renders the component when the language changes. */
export function useT(): typeof t { useLanguage(); return t; }
