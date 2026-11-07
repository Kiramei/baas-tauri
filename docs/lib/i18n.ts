import { defineI18n } from "fumadocs-core/i18n";
import { isLocale, type Locale } from "./locale";
export type { Locale } from "./locale";

export const i18n = defineI18n({
  languages: ["zh", "en"],
  defaultLanguage: "en",
  fallbackLanguage: "en",
  hideLocale: "never",
  parser: "dir",
});

export const locales = [
  { locale: "zh", name: "中文" },
  { locale: "en", name: "English" },
] as const;

/** Returns the normalize locale result. */
export function normalizeLocale(value: string | undefined): Locale {
  return isLocale(value) ? value : "en";
}

/** Handles the switch locale path workflow. */
export function switchLocalePath(pathname: string, _nextLocale: Locale): string {
  return pathname.replace(/(\/docs)\/(?:zh|en)(?=\/|$)/, "$1");
}
