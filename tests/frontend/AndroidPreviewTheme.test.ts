import { describe, expect, test } from "bun:test";
import {
  createPreviewThemeSource,
  nativeThemeColor,
  resolveAndroidPreviewTheme,
} from "../../src/shared/AndroidPreviewTheme";

describe("native preview theme", () => {
  test("neutral defaults follow dark/light mode, not the old blue palette", () => {
    const dark = resolveAndroidPreviewTheme(() => "", true);
    const light = resolveAndroidPreviewTheme(() => "", false);
    expect(dark.primary).toBe("#dfdfdf");
    expect(dark.primaryForeground).toBe("#181818");
    expect(light.primary).toBe("#1a1c1f");
    expect(light.background).toBe("#ffffff");
  });
  test("uses the actual CSS accent and composites translucent borders", () => {
    const tokens: Record<string, string> = {
      "--popover": "#282828",
      "--border": "rgb(223 223 223 / 8%)",
      "--primary": "#c53330",
      "--primary-foreground": "#fff",
    };
    const theme = resolveAndroidPreviewTheme((token) => tokens[token] ?? "", true);
    expect(theme.primary).toBe("#c53330");
    expect(theme.primaryForeground).toBe("#ffffff");
    expect(theme.border).toBe("#373737");
    expect(Object.values(theme).every((color) => /^#[\da-f]{6}$/.test(color))).toBe(true);
  });
  test("normalizes rgba/hex alpha without confusing CSS RGBA and Android ARGB", () => {
    expect(nativeThemeColor("rgba(255, 255, 255, 0.5)", "#000000", "#000000")).toBe("#808080");
    expect(nativeThemeColor("#fff8", "#000000", "#000000")).toBe("#888888");
    expect(nativeThemeColor("#ff000080", "#000000", "#000000")).toBe("#800000");
    for (const color of ["var(--missing)", "rgb(999 0 0)", "rgba(1,2,3,2)", "garbage"])
      expect(nativeThemeColor(color, "#282828")).toBe("#282828");
  });
  test("cached pages share one observer, skip unchanged colors, and release it", () => {
    let value = resolveAndroidPreviewTheme(() => "", false);
    let refresh = () => {};
    let starts = 0,
      stops = 0,
      reads = 0,
      a = 0,
      b = 0;
    const source = createPreviewThemeSource(
      () => {
        reads++;
        return { ...value };
      },
      (callback) => {
        starts++;
        refresh = callback;
        return () => stops++;
      }
    );
    source.getSnapshot();
    const offA = source.subscribe(() => a++);
    const offB = source.subscribe(() => b++);
    const current = source.getSnapshot();
    source.getSnapshot();
    expect(starts).toBe(1);
    expect(reads).toBe(2);
    refresh();
    expect(source.getSnapshot()).toBe(current);
    expect(a + b).toBe(0);
    value = resolveAndroidPreviewTheme(() => "", true);
    refresh();
    expect(a).toBe(1);
    expect(b).toBe(1);
    offA();
    expect(stops).toBe(0);
    offB();
    expect(stops).toBe(1);
    const offC = source.subscribe(() => {});
    expect(starts).toBe(2);
    offC();
  });
});
