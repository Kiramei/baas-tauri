import type { PageKey } from "@/types/app";

/** Removed or unknown routes from old UI state safely return to the home page. */
export function normalizePageKey(page: unknown): PageKey {
  return page === "scheduler" ||
    page === "configuration" ||
    page === "settings" ||
    page === "plugins"
    ? page
    : "home";
}

export const MOBILE_PAGE_KEYS: readonly PageKey[] = [
  "home",
  "scheduler",
  "configuration",
  "settings",
];

/** Plugins remain a stable route while belonging to Settings on mobile. */
export function mobileNavigationPage(page: unknown): PageKey {
  const normalized = normalizePageKey(page);
  return normalized === "plugins" ? "settings" : normalized;
}

export function androidBackDestination(page: PageKey): PageKey | null {
  return page === "home" ? null : page === "plugins" ? "settings" : "home";
}
