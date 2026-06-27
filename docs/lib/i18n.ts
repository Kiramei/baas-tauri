import { defineI18n } from "fumadocs-core/i18n";

export const i18n = defineI18n({
  languages: ["zh", "en"],
  defaultLanguage: "zh",
  fallbackLanguage: "en",
  hideLocale: "never",
  parser: "dir",
});

export const locales = [
  { locale: "zh", name: "中文" },
  { locale: "en", name: "English" },
] as const;

export type Locale = (typeof locales)[number]["locale"];

export function normalizeLocale(value: string | undefined): Locale {
  return value === "en" ? "en" : "zh";
}

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
