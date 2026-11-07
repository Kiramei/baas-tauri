export const localePreferenceKey = "baas-docs-locale";
export type Locale = "zh" | "en";

export function isLocale(value: unknown): value is Locale {
  return value === "zh" || value === "en";
}

/** Extracts the language from links created by earlier versions of the site. */
export function explicitLocaleFromPathname(pathname: string | null): Locale | undefined {
  const segments = pathname?.split("/").filter(Boolean) ?? [];
  const docsIndex = segments.indexOf("docs");
  const locale = docsIndex >= 0 ? segments[docsIndex + 1] : undefined;
  return isLocale(locale) ? locale : undefined;
}

export function localeFromPathname(pathname: string | null): Locale {
  const segments = pathname?.split("/").filter(Boolean) ?? [];
  if (pathname === "/" || pathname === "/docs" || pathname === "/docs/") return "zh";
  const docsIndex = segments.indexOf("docs");
  const locale = docsIndex >= 0 ? segments[docsIndex + 1] : undefined;
  return isLocale(locale) ? locale : "en";
}

/** A deliberate choice wins; otherwise use the first supported browser language. */
export function detectLocale(preference: unknown, languages: readonly string[]): Locale {
  if (preference === "zh" || preference === "en") return preference;
  for (const language of languages) {
    const primary = language.toLowerCase().split(/[-_]/)[0];
    if (primary === "zh" || primary === "en") return primary;
  }
  return "en";
}
