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
export function switchLocalePath(pathname: string, nextLocale: Locale): string {
  const segments = pathname.split("/").filter(Boolean);
  const docsIndex = segments.indexOf("docs");

  if (docsIndex === -1) return `/docs/${nextLocale}`;

  if (segments[docsIndex + 1] === "zh" || segments[docsIndex + 1] === "en") {
    segments[docsIndex + 1] = nextLocale;
  } else {
    segments.splice(docsIndex + 1, 0, nextLocale);
  }

  return `/${segments.join("/")}`;
}
