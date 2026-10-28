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

/** Android embeds plugins in profile configuration; mobile WebUI keeps Settings. */
export function mobileNavigationPage(
  page: unknown,
  platform: "android" | "webui" = "webui"
): PageKey {
  const normalized = normalizePageKey(page);
  return normalized === "plugins"
    ? platform === "android"
      ? "configuration"
      : "settings"
    : normalized;
}

export function androidBackDestination(page: PageKey): PageKey | null {
  return page === "home" ? null : page === "plugins" ? "configuration" : "home";
}
