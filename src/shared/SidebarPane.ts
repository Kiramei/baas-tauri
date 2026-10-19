import type { PageKey } from "@/types/app";

export type SidebarPeekPage = Exclude<PageKey, "settings">;

export interface SidebarPeekContext {
  readonly page: SidebarPeekPage;
  /** A preview belongs to the route from which it was opened. */
  readonly originPage: string;
}

/** Hover changes the pane's content without changing the page shown beside it. */
export function resolveSidebarPane(
  activePage: string,
  desktopExpanded: boolean,
  sidebarLocked: boolean,
  context: SidebarPeekContext | null
): { page: string; peek: boolean } {
  const peek = Boolean(
    context &&
    context.originPage === activePage &&
    !desktopExpanded &&
    !sidebarLocked &&
    activePage !== "settings"
  );
  return { page: peek ? context!.page : activePage, peek };
}
