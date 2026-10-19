import { describe, expect, test } from "bun:test";
import { NavigationHistory, type NavigationView } from "../../src/shared/NavigationHistory";
import { normalizePageKey } from "../../src/shared/PageKey";

const view = (page: NavigationView["page"], profileId: string): NavigationView =>
  page === "settings" ? { page } : { page, profileId };

describe("page and profile navigation history", () => {
  test("back and forward restore both the page and active profile", () => {
    const history = new NavigationHistory();
    let current = view("home", "b-server");
    history.attach((next) => {
      current = { ...next };
      return true;
    });
    history.observe(current, ["b-server", "official"]);
    history.observe(view("scheduler", "b-server"), ["b-server", "official"]);
    history.observe(view("configuration", "official"), ["b-server", "official"]);
    expect(history.back()).toBe(true);
    expect(current).toEqual(view("scheduler", "b-server"));
    history.observe(current, ["b-server", "official"]);
    expect(history.getSnapshot().length).toBe(3);
    expect(history.back()).toBe(true);
    expect(current).toEqual(view("home", "b-server"));
    expect(history.forward()).toBe(true);
    expect(current).toEqual(view("scheduler", "b-server"));
    expect(history.forward()).toBe(true);
    expect(current).toEqual(view("configuration", "official"));
    expect(history.getSnapshot().canForward).toBe(false);
  });

  test("new navigation after back truncates forward history, while repeated commits do not", () => {
    const history = new NavigationHistory();
    history.attach(() => true);
    history.observe(view("home", "one"), ["one"]);
    history.observe(view("scheduler", "one"), ["one"]);
    history.observe(view("settings", "one"), ["one"]);
    history.back();
    history.observe(view("scheduler", "one"), ["one"]);
    expect(history.getSnapshot().canForward).toBe(true);
    expect(history.getSnapshot().length).toBe(3);
    history.observe(view("configuration", "one"), ["one"]);
    expect(history.getSnapshot().length).toBe(3);
    expect(history.getSnapshot().canForward).toBe(false);
    history.back();
    expect(history.getSnapshot().current).toEqual(view("scheduler", "one"));
  });

  test("profile-only changes are meaningful, identical views are deduplicated", () => {
    const history = new NavigationHistory();
    history.attach(() => true);
    history.observe(view("home", "one"), ["one", "two"]);
    history.observe(view("home", "one"), ["one", "two"]);
    history.observe(view("home", "two"), ["one", "two"]);
    expect(history.getSnapshot().length).toBe(2);
    expect(history.back()).toBe(true);
    expect(history.getSnapshot().current).toEqual(view("home", "one"));
  });

  test("deleted profiles are skipped in either direction", () => {
    const history = new NavigationHistory();
    const restored: Readonly<NavigationView>[] = [];
    history.attach((next) => {
      restored.push(next);
      return true;
    });
    history.observe(view("home", "one"), ["one", "deleted"]);
    history.observe(view("configuration", "deleted"), ["one", "deleted"]);
    history.observe(view("settings", "one"), ["one", "deleted"]);
    history.observe(view("settings", "one"), ["one"]);
    expect(history.back()).toBe(true);
    expect(restored.at(-1)).toEqual(view("home", "one"));
    expect(history.forward()).toBe(true);
    expect(restored.at(-1)).toEqual(view("settings", "one"));
    expect(restored.some((entry) => entry.profileId === "deleted")).toBe(false);
  });

  test("profile deletion during a click skips the stale candidate safely", () => {
    const history = new NavigationHistory();
    history.attach((next) => next.profileId !== "stale");
    history.observe(view("home", "one"), ["one", "stale"]);
    history.observe(view("configuration", "stale"), ["one", "stale"]);
    history.observe(view("settings", "one"), ["one", "stale"]);
    expect(history.back()).toBe(true);
    expect(history.getSnapshot().current).toEqual(view("home", "one"));
  });

  test("removing an intermediate profile does not expose a back step to the identical view", () => {
    const history = new NavigationHistory();
    history.attach(() => true);
    history.observe(view("home", "one"), ["one", "deleted"]);
    history.observe(view("configuration", "deleted"), ["one", "deleted"]);
    history.observe(view("home", "one"), ["one", "deleted"]);
    history.observe(view("home", "one"), ["one"]);
    expect(history.getSnapshot().canBack).toBe(false);
    expect(history.back()).toBe(false);
  });

  test("empty history and detached setup cannot navigate; stale cleanup cannot detach a new owner", () => {
    const history = new NavigationHistory();
    expect(history.getSnapshot().canBack).toBe(false);
    expect(history.back()).toBe(false);
    const oldCleanup = history.attach(() => true);
    history.observe(view("home", "one"), ["one"]);
    history.observe(view("settings", "one"), ["one"]);
    const cleanup = history.attach(() => true);
    oldCleanup();
    expect(history.back()).toBe(true);
    cleanup();
    expect(history.getSnapshot().available).toBe(false);
    expect(history.getSnapshot().canForward).toBe(false);
    expect(history.forward()).toBe(false);
  });

  test("removed Wiki routes and unknown old page values safely resolve to home", () => {
    expect(normalizePageKey("wiki")).toBe("home");
    expect(normalizePageKey("removed-page")).toBe("home");
    expect(normalizePageKey(undefined)).toBe("home");
    expect(normalizePageKey("scheduler")).toBe("scheduler");
    const history = new NavigationHistory();
    const restored: Readonly<NavigationView>[] = [];
    history.attach((next) => {
      restored.push(next);
      return true;
    });
    history.observe(view("home", "one"), ["one"]);
    history.observe(view("wiki" as NavigationView["page"], "one"), ["one"]);
    expect(history.getSnapshot().length).toBe(1);
    history.observe(view("settings", "one"), ["one"]);
    expect(history.back()).toBe(true);
    expect(restored.at(-1)).toEqual(view("home", "one"));
  });

  test("settings is a global view that remains available without profiles", () => {
    const history = new NavigationHistory();
    const restored: Readonly<NavigationView>[] = [];
    history.attach((next) => {
      restored.push(next);
      return true;
    });
    history.observe({ page: "settings" }, []);
    expect(history.getSnapshot().available).toBe(true);
    expect(history.getSnapshot().current).toEqual({ page: "settings" });
    history.observe(view("home", "one"), ["one"]);
    expect(history.back()).toBe(true);
    expect(restored.at(-1)).toEqual({ page: "settings" });
    history.observe({ page: "settings" }, []);
    expect(history.getSnapshot().canForward).toBe(false);
  });

  test("legacy profile-specific settings entries normalize to one global history entry", () => {
    const history = new NavigationHistory();
    history.attach(() => true);
    history.observe({ page: "settings", profileId: "one" }, ["one", "two"]);
    history.observe({ page: "settings", profileId: "two" }, ["one", "two"]);
    expect(history.getSnapshot().length).toBe(1);
    expect(history.getSnapshot().current).toEqual({ page: "settings" });
    expect(history.getSnapshot().canBack).toBe(false);
  });

  test("the menu opens global settings even before the first profile is created", () => {
    const history = new NavigationHistory();
    expect(history.openSettings()).toBe(false);
    let current: Readonly<NavigationView> | undefined;
    history.attach((next) => {
      current = next;
      return true;
    });
    history.observe(null, []);
    expect(history.getSnapshot().available).toBe(true);
    expect(history.openSettings()).toBe(true);
    expect(current).toEqual({ page: "settings" });
    expect(history.getSnapshot().current).toEqual({ page: "settings" });
    expect(history.getSnapshot().canBack).toBe(false);
    expect(history.openSettings()).toBe(true);
    expect(history.getSnapshot().length).toBe(1);
  });
});
