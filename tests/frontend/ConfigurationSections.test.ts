import { describe, expect, test } from "bun:test";
import {
  CONFIGURATION_SECTIONS,
  filterConfigurationSections,
  getConfigurationSections,
  resolveConfigurationSection,
  resolveConfigurationSearchTab,
} from "../../src/shared/ConfigurationSections";
import { featureTranslationKey } from "../../src/shared/I18nKeys";
import type { TranslationKey } from "../../src/types/i18n";
import zh from "../../public/locales/zh.json";
import en from "../../public/locales/en.json";
import de from "../../public/locales/de.json";
import fr from "../../public/locales/fr.json";
import ja from "../../public/locales/ja.json";
import ko from "../../public/locales/ko.json";
import ru from "../../public/locales/ru.json";

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

const matches = (query: string, locale: Record<string, unknown>) =>
  filterConfigurationSections(query, translator(locale)).map((section) => section.id);
const locales = [zh, en, de, fr, ja, ko, ru];

describe("profile configuration navigation", () => {
  test("new upstream controls are searchable in every supported language", () => {
    for (const locale of locales) {
      const translate = translator(locale);
      for (const [key, section] of [
        ["push.telegram", "push"],
        ["push.feishu", "push"],
        ["push.wecom", "push"],
        ["push.telegramChatId", "push"],
        ["arena.stopAtFirstPlace", "arena"],
        ["stage.simpleMode", "stage"],
        ["stage.mainStoryEpisodes", "stage"],
        ["cafe.interactionShotDelay", "cafe"],
      ] as const) {
        for (const platform of ["desktop", "android", "webui"] as const) {
          expect(
            filterConfigurationSections(translate(key), translate, platform).map(({ id }) => id)
          ).toContain(section);
        }
      }
      expect(
        resolveConfigurationSearchTab("stage", translate("stage.mainStoryEpisodes"), translate)
      ).toBe("explore");
      expect(
        resolveConfigurationSearchTab("cafe", translate("cafe.interactionShotDelay"), translate)
      ).toBe("basic");
    }
  });

  test("WebUI keeps device configuration without advertising host window actions", () => {
    expect(getConfigurationSections("webui").map(({ id }) => id)).not.toContain("emulator");
    expect(resolveConfigurationSection("emulator", "webui").id).toBe("cafe");
    for (const locale of locales) {
      const translate = translator(locale);
      for (const key of [
        "script.then",
        "script.exitEmu",
        "script.exitBaas",
        "script.shutdown",
        "configurationHelp.emulatorPath",
      ] as const) {
        const matches = filterConfigurationSections(translate(key), translate, "webui").map(
          ({ id }) => id
        );
        expect(matches).not.toContain("script");
        expect(matches).not.toContain("emulator");
      }
      expect(
        filterConfigurationSections(translate("server.adbPort"), translate, "webui").map(
          ({ id }) => id
        )
      ).toContain("server");
      expect(
        filterConfigurationSections(translate("script.screenshotMethod"), translate, "webui").map(
          ({ id }) => id
        )
      ).toContain("script");
    }
  });

  test("Android keeps plugin management inside configuration and excludes emulator setup", () => {
    const android = getConfigurationSections("android");
    expect(android.map(({ id }) => id)).toEqual([
      ...CONFIGURATION_SECTIONS.filter(({ id }) => id !== "emulator").map(({ id }) => id),
      "plugins",
    ]);
    expect(android).toHaveLength(17);
    expect(android.filter(({ group }) => group === "general").map(({ id }) => id)).toEqual([
      "server",
      "script",
      "stage",
      "team",
      "push",
      "other",
      "plugins",
    ]);
    expect(getConfigurationSections("desktop")).toBe(CONFIGURATION_SECTIONS);
    expect(getConfigurationSections("webui").map(({ id }) => id)).not.toContain("plugins");
    for (const locale of locales) {
      const translate = translator(locale);
      expect(
        filterConfigurationSections(translate("plugins.title"), translate, "android").map(
          ({ id }) => id
        )
      ).toContain("plugins");
    }
  });

  test("an unavailable saved Android panel safely falls back to Cafe", () => {
    expect(resolveConfigurationSection("emulator", "android").id).toBe("cafe");
    expect(resolveConfigurationSection("emulator", "desktop").id).toBe("emulator");
    for (const section of getConfigurationSections("android")) {
      expect(resolveConfigurationSection(section.id, "android")).toBe(section);
    }
  });

  test("Android navigation and search share the supported panel catalog in every language", () => {
    for (const locale of locales) {
      const translate = translator(locale);
      expect(filterConfigurationSections("", translate, "android")).toEqual(
        getConfigurationSections("android")
      );
      for (const key of [
        "emulator",
        "emulator.address",
        "emulator.instanceCount",
        "configurationHelp.emulatorInstance",
      ] as const) {
        expect(
          filterConfigurationSections(translate(key), translate, "android").map(({ id }) => id)
        ).not.toContain("emulator");
        expect(
          filterConfigurationSections(translate(key), translate, "desktop").map(({ id }) => id)
        ).toContain("emulator");
      }
    }
  });

  test("Android search does not advertise its hidden desktop capture/control selectors", () => {
    for (const locale of locales) {
      const translate = translator(locale);
      for (const key of [
        "script.screenshotMethod",
        "script.controlMethod",
        "configurationHelp.screenshotMethod",
        "configurationHelp.controlMethod",
      ] as const) {
        expect(
          filterConfigurationSections(translate(key), translate, "android").map(({ id }) => id)
        ).not.toContain("script");
        expect(
          filterConfigurationSections(translate(key), translate, "desktop").map(({ id }) => id)
        ).toContain("script");
      }
      expect(
        filterConfigurationSections(
          translate("script.screenshotInterval"),
          translate,
          "android"
        ).map(({ id }) => id)
      ).toContain("script");
      expect(
        resolveConfigurationSearchTab("cafe", translate("cafe.patRounds"), translate, "android")
      ).toBe("basic");
    }
  });

  test("retains all configuration panels in their existing group and display order", () => {
    expect(
      CONFIGURATION_SECTIONS.filter((section) => section.group === "feature").map((s) => s.id)
    ).toEqual([
      "cafe",
      "schedule",
      "shop",
      "artifact",
      "arena",
      "dailySweep",
      "tactical",
      "finalRestrictionRls",
      "drill",
      "whitelist",
    ]);
    expect(
      CONFIGURATION_SECTIONS.filter((section) => section.group === "general").map((s) => s.id)
    ).toEqual(["server", "script", "emulator", "stage", "team", "push", "other"]);
    expect(new Set(CONFIGURATION_SECTIONS.map((section) => section.id)).size).toBe(17);
    for (const section of CONFIGURATION_SECTIONS) {
      expect(section.title).toBe(featureTranslationKey(section.id));
      expect(section.description).toBe(featureTranslationKey(`${section.id}Desc`));
    }
  });

  test("missing, malformed and removed selections safely open Cafe", () => {
    for (const value of [undefined, null, "", "removed", "__proto__", {}, [], 0]) {
      expect(resolveConfigurationSection(value).id).toBe("cafe");
    }
    for (const section of CONFIGURATION_SECTIONS) {
      expect(resolveConfigurationSection(section.id)).toBe(section);
    }
  });

  test("finds panels by translated titles, descriptions and actual control labels", () => {
    expect(matches("咖啡厅", zh)).toEqual(["cafe"]);
    expect(matches("Capture interval", en)).toEqual(["script"]);
    expect(matches("截图间隔", zh)).toEqual(["script"]);
    expect(matches("复制通关队伍", zh)).toEqual(["finalRestrictionRls"]);
    expect(matches("离线天数", zh)).toEqual(["whitelist"]);
    expect(matches("JSON", en)).toEqual(["push"]);
    expect(matches("Items to purchase", en)).toEqual(["shop"]);
  });

  test("search follows the current language without exposing internal key names", () => {
    expect(matches("截图间隔", en)).toEqual([]);
    expect(matches("Capture interval", zh)).toEqual([]);
    expect(matches("script.screenshotInterval", en)).toEqual([]);
    expect(matches("  cApTuRe\tINTERVAL\n", en)).toEqual(["script"]);
    expect(matches("  ", zh)).toEqual(CONFIGURATION_SECTIONS.map((section) => section.id));
  });

  test("all whitespace-separated terms must match the same panel", () => {
    expect(matches("ADB port", en)).toEqual(["server"]);
    expect(matches("咖啡厅 邀请券", zh)).toEqual(["cafe"]);
    expect(matches("capture interval seconds", en)).toEqual(["script"]);
    expect(matches("截图间隔 白名单", zh)).toEqual([]);
    expect(matches("unavailable-never-matches", en)).toEqual([]);
  });

  test("every indexed title, description and control has copy in all supported languages", () => {
    for (const locale of locales) {
      const translate = translator(locale);
      for (const section of CONFIGURATION_SECTIONS) {
        for (const key of [
          section.title,
          section.description,
          ...section.keywords,
          ...(section.tabs?.flatMap((tab) => [tab.title, ...tab.keywords]) ?? []),
        ]) {
          expect(translate(key)).not.toBe(key);
          expect(translate(key).trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("search resolves controls to their existing nested tab without changing configuration", () => {
    const cases = [
      ["cafe", "cafe.invite1Mode", "cafe1"],
      ["cafe", "cafe.patRounds", "basic"],
      ["cafe", "cafe.cafe2Settings", "cafe2"],
      ["cafe", "configurationHelp.cafeSecondCafe", "basic"],
      ["dailySweep", "stage.hardLabel", "daily"],
      ["dailySweep", "sweep.purchaseScrimmage", "sweep"],
      ["shop", "tacticalShop.title", "tactical"],
      ["shop", "commonShop.refreshTimes", "common"],
      ["artifact", "artifact.createTime", "global"],
      ["artifact", "artifact.materialSelect", "phase1"],
      ["artifact", "artifact.phase2.recommend", "phase2"],
      ["artifact", "artifact.phase3", "phase3"],
      ["stage", "stage.manualBoss", "explore"],
      ["stage", "stage.challenge", "event"],
    ] as const;
    for (const locale of locales) {
      const translate = translator(locale);
      for (const [section, key, tab] of cases) {
        expect(resolveConfigurationSearchTab(section, translate(key), translate)).toBe(tab);
      }
    }
  });

  test("nested tab selection matches the current language, case and multiple terms", () => {
    const translate = translator(en);
    expect(resolveConfigurationSearchTab("cafe", "  INVITATION\tMODE  ", translate)).toBe("cafe1");
    expect(resolveConfigurationSearchTab("cafe", "Cafe 2 Invitation Mode", translate)).toBe(
      "cafe2"
    );
    expect(resolveConfigurationSearchTab("artifact", "Crafting stages", translate)).toBe("global");
    expect(resolveConfigurationSearchTab("artifact", "Materials Node 2", translate)).toBe("phase2");
    expect(resolveConfigurationSearchTab("dailySweep", "Commissions count", translate)).toBe(
      "sweep"
    );
    expect(resolveConfigurationSearchTab("shop", "Tactical Challenge Shop", translate)).toBe(
      "tactical"
    );
    expect(resolveConfigurationSearchTab("stage", "Current Event", translate)).toBe("event");
    expect(resolveConfigurationSearchTab("cafe", "邀请模式", translate)).toBeNull();
    expect(matches("咖啡厅2", zh)).toEqual(["cafe"]);
    expect(matches("Node 2", en)).toEqual(["artifact"]);
  });

  test("generic names, overview copy and non-tabbed panels preserve the current nested tab", () => {
    for (const locale of locales) {
      const translate = translator(locale);
      for (const section of CONFIGURATION_SECTIONS) {
        expect(
          resolveConfigurationSearchTab(section.id, translate(section.title), translate)
        ).toBeNull();
        expect(
          resolveConfigurationSearchTab(section.id, translate(section.description), translate)
        ).toBeNull();
      }
    }
    for (const query of ["", "  ", "unknown-setting", "截图间隔 白名单"]) {
      expect(resolveConfigurationSearchTab("cafe", query, translator(zh))).toBeNull();
    }
    expect(resolveConfigurationSearchTab("script", "截图间隔", translator(zh))).toBeNull();
    expect(resolveConfigurationSearchTab("removed", "邀请模式", translator(zh))).toBeNull();
  });

  test("structured sweep controls remain discoverable in the counts tab", () => {
    for (const query of ["体力比例", "平均分配", "全部次数", "崔尼蒂", "物品回收"]) {
      expect(matches(query, zh)).toEqual(["dailySweep"]);
      expect(resolveConfigurationSearchTab("dailySweep", query, translator(zh))).toBe("sweep");
    }
    for (const query of ["AP share", "Split all AP", "All attempts", "Item Retrieval"]) {
      expect(matches(query, en)).toContain("dailySweep");
      expect(resolveConfigurationSearchTab("dailySweep", query, translator(en))).toBe("sweep");
    }
    for (const locale of locales) {
      const translate = translator(locale);
      for (const key of [
        "configurationCounts.share",
        "configurationCounts.allActivity",
        "configurationCounts.scrimmageTrinity",
        "configurationCounts.specialRetrieval",
        "configurationCounts.bountyOverpass",
        "configurationCounts.bountyRailroad",
        "configurationCounts.bountyClassroom",
      ] as const) {
        expect(matches(translate(key), locale)).toEqual(["dailySweep"]);
        expect(resolveConfigurationSearchTab("dailySweep", translate(key), translate)).toBe(
          "sweep"
        );
      }
    }
  });

  test("stage-list terms open the sweep plan rather than the count settings", () => {
    expect(matches("关卡", zh)).toContain("dailySweep");
    expect(matches("关卡", zh)).toContain("stage");
    expect(resolveConfigurationSearchTab("dailySweep", "关卡", translator(zh))).toBe("daily");
    expect(resolveConfigurationSearchTab("dailySweep", "添加关卡", translator(zh))).toBe("daily");
    expect(resolveConfigurationSearchTab("dailySweep", "Add stage", translator(en))).toBe("daily");
    expect(resolveConfigurationSearchTab("stage", "整章", translator(zh))).toBe("explore");
    expect(resolveConfigurationSearchTab("stage", "Whole chapter", translator(en))).toBe("explore");
  });

  test("priority-list words locate crafting phases and respect explicit phase names", () => {
    expect(matches("选择节点", zh)).toEqual(["artifact"]);
    expect(matches("Select nodes", en)).toEqual(["artifact"]);
    expect(resolveConfigurationSearchTab("artifact", "选择节点", translator(zh))).toBe("phase1");
    expect(resolveConfigurationSearchTab("artifact", "第三节点 选择节点", translator(zh))).toBe(
      "phase3"
    );
    expect(resolveConfigurationSearchTab("artifact", "Node 2 Select nodes", translator(en))).toBe(
      "phase2"
    );
    expect(resolveConfigurationSearchTab("artifact", "制造", translator(zh))).toBeNull();
  });

  test("explanatory setting copy participates in the relevant panel search", () => {
    expect(matches("清理条件中的等级阈值", zh)).toEqual(["whitelist"]);
    expect(matches("instance manager", en)).toEqual(["emulator"]);
    expect(matches("between captures", en)).toEqual(["script"]);
    expect(matches("not how many instances", en)).toEqual(["emulator"]);
    expect(matches("bodyguard never matches", en)).toEqual([]);
    for (const locale of locales) {
      const translate = translator(locale);
      for (const [key, section] of [
        ["configurationHelp.friendLevel", "whitelist"],
        ["configurationHelp.emulatorInstance", "emulator"],
        ["configurationHelp.screenshotInterval", "script"],
      ] as const) {
        expect(matches(translate(key), locale)).toEqual([section]);
      }
    }
  });
});
