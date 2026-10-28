import { describe, expect, test } from "bun:test";
import { resolveSidebarPane, type SidebarPeekPage } from "../../src/shared/SidebarPane";

const pages: SidebarPeekPage[] = ["home", "scheduler", "configuration"];

describe("collapsed sidebar preview context", () => {
  test("each hovered navigation item chooses its own pane independently of the active page", () => {
    for (const activePage of pages) {
      for (const page of pages) {
        expect(
          resolveSidebarPane(activePage, false, false, { page, originPage: activePage })
        ).toEqual({ page, peek: true });
      }
    }
  });

  test("expanding a preview restores the actual page's persistent pane", () => {
    for (const activePage of pages) {
      for (const page of pages) {
        expect(
          resolveSidebarPane(activePage, true, false, { page, originPage: activePage })
        ).toEqual({ page: activePage, peek: false });
      }
    }
  });

  test("route changes invalidate stale previews before any cleanup effect runs", () => {
    for (const originPage of pages) {
      for (const activePage of pages.filter((page) => page !== originPage)) {
        expect(
          resolveSidebarPane(activePage, false, false, {
            page: "configuration",
            originPage,
          })
        ).toEqual({ page: activePage, peek: false });
      }
    }
  });

  test("Settings and any locked sidebar keep their actual page content", () => {
    for (const page of pages) {
      expect(
        resolveSidebarPane("settings", false, false, { page, originPage: "settings" })
      ).toEqual({ page: "settings", peek: false });
      expect(resolveSidebarPane("home", false, true, { page, originPage: "home" })).toEqual({
        page: "home",
        peek: false,
      });
    }
  });

  test("a closed pane has no preview context", () => {
    expect(resolveSidebarPane("configuration", false, false, null)).toEqual({
      page: "configuration",
      peek: false,
    });
  });
});
