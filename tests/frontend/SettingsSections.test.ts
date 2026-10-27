import { describe, expect, test } from "bun:test";
import {
  filterSettingsSections,
  resolveSettingsSection,
  SETTINGS_SECTIONS,
  WEBUI_SETTINGS_SECTIONS,
} from "../../src/shared/SettingsSections";
import type { TranslationKey } from "../../src/types/i18n";
import zh from "../../public/locales/zh.json";
import en from "../../public/locales/en.json";

function translator(locale: Record<string, unknown>) {
  return (key: TranslationKey): string => {
    const value = key
      .split(".")
      .reduce<unknown>(
        (item, part) =>
          item && typeof item === "object" ? (item as Record<string, unknown>)[part] : undefined,
        locale
      );
    return typeof value === "string" ? value : ((value as Record<string, string>)?.$self ?? key);
  };
}

describe("global settings categories", () => {
  test("missing or old persisted selection opens General", () => {
    for (const value of [undefined, null, "removed", "", {}]) {
      expect(resolveSettingsSection(value).id).toBe("general");
    }
    expect(resolveSettingsSection("appearance").id).toBe("appearance");
  });

  test("search finds a category by translated setting names", () => {
    expect(
      filterSettingsSections("background", translator(en)).map((section) => section.id)
    ).toEqual(["appearance"]);
    expect(filterSettingsSections("背景", translator(zh)).map((section) => section.id)).toEqual([
      "appearance",
    ]);
    expect(filterSettingsSections("运行", translator(zh)).map((section) => section.id)).toEqual([
      "runtime",
    ]);
  });

  test("search uses the current language and ignores case/whitespace", () => {
    expect(
      filterSettingsSections("  UPDATES  ", translator(en)).map((section) => section.id)
    ).toEqual(["updates"]);
    expect(filterSettingsSections("更新", translator(en))).toHaveLength(0);
    expect(filterSettingsSections("更新", translator(zh)).map((section) => section.id)).toEqual([
      "updates",
    ]);
    expect(filterSettingsSections("  ", translator(zh))).toHaveLength(SETTINGS_SECTIONS.length);
  });

  test("multiword searches stay within one category and can return no results", () => {
    expect(
      filterSettingsSections("background color", translator(en)).map((section) => section.id)
    ).toEqual(["appearance"]);
    expect(filterSettingsSections("background updates", translator(en))).toHaveLength(0);
  });

  test("shortcut category indexes editable actions and native text commands", () => {
    expect(resolveSettingsSection("shortcuts").id).toBe("shortcuts");
    for (const search of ["撤销", "侧边栏", "剪切"]) {
      expect(filterSettingsSections(search, translator(zh)).map((section) => section.id)).toEqual([
        "shortcuts",
      ]);
    }
    expect(
      filterSettingsSections("select all", translator(en)).map((section) => section.id)
    ).toEqual(["shortcuts"]);
  });

  test("browser search excludes native controls while preserving local and backend settings", () => {
    const t = translator(en);
    for (const key of [
      "settings.ui.enableSystemNotifications",
      "workflow.minimizeToTray",
      "settings.shortcuts.global",
      "transport.label",
      "about.clientVersion",
      "settings.ui.idleAutoUpdate",
    ] as const) {
      expect(filterSettingsSections(t(key), t, WEBUI_SETTINGS_SECTIONS)).toHaveLength(0);
      expect(filterSettingsSections(t(key), t).length).toBeGreaterThan(0);
    }
    for (const [key, section] of [
      ["settings.ui.player", "runtime"],
      ["settings.ui.enableSafeStream", "runtime"],
      ["about.backendCommit", "updates"],
      ["edit.cut", "shortcuts"],
      ["settings.ui.backgroundImage", "appearance"],
      ["settings.systemLogs.title", "logs"],
    ] as const) {
      expect(
        filterSettingsSections(t(key), t, WEBUI_SETTINGS_SECTIONS).map(({ id }) => id)
      ).toContain(section);
    }
    expect(WEBUI_SETTINGS_SECTIONS.map(({ id }) => id)).toEqual(
      SETTINGS_SECTIONS.map(({ id }) => id)
    );
  });
});
