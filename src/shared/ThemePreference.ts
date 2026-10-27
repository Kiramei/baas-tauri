import type { Theme } from "@/types/app";

export function isThemePreference(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

/** Keep the pre-bundle preference when browser storage becomes unavailable later. */
export function readThemePreference(
  bootstrapped: unknown,
  readSaved: () => string | null = () => localStorage.getItem("theme")
): Theme {
  if (isThemePreference(bootstrapped)) return bootstrapped;
  try {
    const saved = readSaved();
    if (isThemePreference(saved)) return saved;
  } catch {
    // Privacy settings may deny access even to the localStorage getter.
  }
  return "system";
}

export function saveThemePreference(
  theme: Theme,
  writeSaved: (theme: Theme) => void = (value) => localStorage.setItem("theme", value)
): void {
  try {
    writeSaved(theme);
  } catch {
    // Applying a theme for this session must not depend on available storage quota.
  }
}

/** Apply before paint, then follow OS changes only for the system preference. */
export function watchThemePreference(
  theme: Theme,
  root: Pick<HTMLElement, "classList" | "dataset">,
  mediaQuery: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">
): () => void {
  const apply = () => {
    const dark = theme === "dark" || (theme === "system" && mediaQuery.matches);
    root.classList.remove("light", "dark");
    root.classList.add(dark ? "dark" : "light");
    root.dataset.themePreference = theme;
  };
  apply();
  if (theme !== "system") return () => {};
  mediaQuery.addEventListener("change", apply);
  return () => mediaQuery.removeEventListener("change", apply);
}
