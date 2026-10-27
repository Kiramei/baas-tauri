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
