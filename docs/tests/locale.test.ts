import { describe, expect, test } from "bun:test";
import { detectLocale } from "../lib/locale";

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
