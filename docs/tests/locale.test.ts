import { describe, expect, test } from "bun:test";
import { detectLocale, localeFromPathname } from "../lib/locale";

describe("documentation entry language", () => {
  test.each([
    [null, ["zh-CN", "en-US"], "zh"],
    [null, ["zh-Hant-TW"], "zh"],
    [null, ["EN_us"], "en"],
    [null, ["ja-JP", "en-US", "zh-CN"], "en"],
    [null, ["de-DE"], "en"],
    [null, [], "en"],
    ["en", ["zh-CN"], "en"],
    ["zh", ["en-US"], "zh"],
    ["invalid", ["zh-CN"], "zh"],
  ])("preference %p, environment %p -> %s", (preference, languages, expected) => {
    expect(detectLocale(preference, languages as string[])).toBe(expected);
  });
});

test.each([
  ["/docs/zh/guide/android/", "zh"],
  ["/docs/en/reference/updater-internals/", "en"],
  ["/baas/docs/zh/", "zh"],
  ["/docs/ja/", "en"],
  ["/docs/", "en"],
  ["/", "en"],
  [null, "en"],
])("framework and search language for %p -> %s", (pathname, expected) => {
  expect(localeFromPathname(pathname)).toBe(expected);
});
