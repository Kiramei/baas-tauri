import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  readThemePreference,
  saveThemePreference,
  watchThemePreference,
} from "../../src/shared/ThemePreference";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const bootstrap = html.match(/<script id="baas-theme-bootstrap">([\s\S]*?)<\/script>/)?.[1];
if (!bootstrap) throw new Error("The parser-blocking theme bootstrap is missing");

function createRoot() {
  const classes = new Set<string>();
  return {
    classes,
    element: {
      classList: {
        add: (...values: string[]) => values.forEach((value) => classes.add(value)),
        remove: (...values: string[]) => values.forEach((value) => classes.delete(value)),
      } as unknown as DOMTokenList,
      dataset: {} as DOMStringMap,
    },
  };
}

function runBootstrap(saved: string | null, systemDark: boolean, denyStorage = false) {
  const root = createRoot();
  const context = {
    document: { documentElement: root.element },
    window: { matchMedia: () => ({ matches: systemDark }) },
  };
  Object.defineProperty(context, "localStorage", {
    get: () => {
      if (denyStorage) throw new DOMException("Storage is disabled", "SecurityError");
      return { getItem: () => saved };
    },
  });
  runInNewContext(bootstrap!, context);
  return root;
}

describe("theme before the application bundle", () => {
  test.each([
    ["dark", false, "dark", "dark"],
    ["light", true, "light", "light"],
    ["system", true, "dark", "system"],
    ["system", false, "light", "system"],
    [null, true, "dark", "system"],
    ["invalid", false, "light", "system"],
    ['"dark"', true, "dark", "system"],
  ] as const)("saved %s with OS dark=%s resolves before CSS", (saved, os, resolved, preference) => {
    const { element, classes } = runBootstrap(saved, os);
    expect([...classes]).toEqual([resolved]);
    expect(element.dataset.themePreference).toBe(preference);
    // The React handoff uses the exact preference that produced the first paint.
    expect(readThemePreference(element.dataset.themePreference)).toBe(preference);
  });

  test("storage getter denial follows the OS and does not abort startup", () => {
    const root = runBootstrap(null, true, true);
    expect([...root.classes]).toEqual(["dark"]);
    expect(root.element.dataset.themePreference).toBe("system");
    expect(
      readThemePreference(undefined, () => {
        throw new DOMException("Storage is disabled", "SecurityError");
      })
    ).toBe("system");
  });

  test("handoff keeps a valid bootstrap result when later storage reads fail", () => {
    expect(
      readThemePreference("dark", () => {
        throw new Error("A later storage failure must not change the first-paint preference");
      })
    ).toBe("dark");
    expect(readThemePreference(undefined, () => "light")).toBe("light");
    expect(readThemePreference(undefined, () => "invalid")).toBe("system");
  });

  test("saving a theme still applies for this session if storage is full", () => {
    expect(() =>
      saveThemePreference("dark", () => {
        throw new DOMException("Storage is full", "QuotaExceededError");
      })
    ).not.toThrow();
    let saved = "";
    saveThemePreference("light", (value) => {
      saved = value;
    });
    expect(saved).toBe("light");
  });
});

describe("live system-theme handoff", () => {
  function createMediaQuery(systemDark: boolean) {
    const listeners = new Set<() => void>();
    const query = {
      matches: systemDark,
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    };
    return {
      query: query as unknown as Parameters<typeof watchThemePreference>[2],
      listeners,
      change: (dark: boolean) => {
        query.matches = dark;
        listeners.forEach((listener) => listener());
      },
    };
  }

  test("system changes update the document and release the listener on cleanup", () => {
    const root = createRoot();
    const media = createMediaQuery(true);
    const stop = watchThemePreference("system", root.element, media.query);
    expect([...root.classes]).toEqual(["dark"]);
    expect(media.listeners.size).toBe(1);
    media.change(false);
    expect([...root.classes]).toEqual(["light"]);
    expect(root.element.dataset.themePreference).toBe("system");
    stop();
    expect(media.listeners.size).toBe(0);
    media.change(true);
    expect([...root.classes]).toEqual(["light"]);
  });

  test.each(["light", "dark"] as const)("an explicit %s theme ignores OS changes", (theme) => {
    const root = createRoot();
    const media = createMediaQuery(theme === "light");
    const stop = watchThemePreference(theme, root.element, media.query);
    expect([...root.classes]).toEqual([theme]);
    expect(media.listeners.size).toBe(0);
    media.change(theme !== "light");
    expect([...root.classes]).toEqual([theme]);
    stop();
  });
});
