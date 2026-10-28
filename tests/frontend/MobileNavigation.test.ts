import { describe, expect, test } from "bun:test";
import {
  androidBackDestination,
  MOBILE_PAGE_KEYS,
  mobileNavigationPage,
  normalizePageKey,
} from "../../src/shared/PageKey";
import { NavigationHistory, type NavigationView } from "../../src/shared/NavigationHistory";

describe("mobile plugin navigation", () => {
  test("keeps four bottom destinations and the compatible plugin route", () => {
    expect(MOBILE_PAGE_KEYS).toEqual(["home", "scheduler", "configuration", "settings"]);
    expect(normalizePageKey("plugins")).toBe("plugins");
    expect(mobileNavigationPage("plugins")).toBe("settings");
    for (const page of MOBILE_PAGE_KEYS) expect(mobileNavigationPage(page)).toBe(page);
  });

  test("visiting plugins from settings can return without a game profile", () => {
    const history = new NavigationHistory();
    let current: Readonly<NavigationView> = { page: "settings" };
    history.attach((next) => {
      current = next;
      return true;
    });
    history.observe(current, []);
    history.observe({ page: "plugins" }, []);
    expect(mobileNavigationPage(history.getSnapshot().current?.page)).toBe("settings");
    expect(history.back()).toBe(true);
    expect(current).toEqual({ page: "settings" });
    expect(history.forward()).toBe(true);
    expect(current).toEqual({ page: "plugins" });
  });

  test("native Back returns from plugins to settings before returning home", () => {
    expect(androidBackDestination("plugins")).toBe("settings");
    expect(androidBackDestination("settings")).toBe("home");
    expect(androidBackDestination("configuration")).toBe("home");
    expect(androidBackDestination("scheduler")).toBe("home");
    expect(androidBackDestination("home")).toBeNull();
  });
});
