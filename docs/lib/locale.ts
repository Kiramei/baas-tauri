export const localePreferenceKey = "baas-docs-locale";
export type Locale = "zh" | "en";

export function isLocale(value: unknown): value is Locale {
  return value === "zh" || value === "en";
}

/** A deliberate choice wins; otherwise use the first supported browser language. */
export function detectLocale(preference: unknown, languages: readonly string[]): Locale {
  if (isLocale(preference)) return preference;
  for (const language of languages) {
    const primary = language.toLowerCase().split(/[-_]/)[0];
    if (isLocale(primary)) return primary;
  }
  return "en";
}
