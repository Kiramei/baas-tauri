import en from "../../public/locales/en.json";
import zh from "../../public/locales/zh.json";
import ja from "../../public/locales/ja.json";
import ko from "../../public/locales/ko.json";
import de from "../../public/locales/de.json";
import fr from "../../public/locales/fr.json";
import ru from "../../public/locales/ru.json";
import { parseSweepPlan, serializeSweepPlan, sweepPlanAllowsMax } from "../../src/shared/SweepPlan";
import { createExplorePlanEntry, parseExplorePlan } from "../../src/shared/ExplorePlan";
import {
  isActivitySweepCountStringValid,
  isSweepCountStringValid,
  readActivitySweepCounts,
  activitySweepCountToken,
} from "../../src/shared/SweepCounts";
import { rewardedTaskRegionCount } from "../../src/features/rewardedTaskConfig";
import { REDACTED } from "./redaction";

export type ConfigValue = string | number | boolean;
export type ConfigControlType =
  | "select"
  | "multiselect"
  | "number"
  | "switch"
  | "text"
  | "list"
  | "rows";
export interface ConfigOption {
  label: string;
  value: ConfigValue;
  disabled?: boolean;
}
export interface ConfigColumn {
  key: string;
  label: string;
  type: "select" | "number" | "text";
  options?: ConfigOption[];
  min?: number;
  max?: number;
  integer?: boolean;
  step?: number;
  sensitive?: boolean;
  description?: string;
}
export interface ConfigField {
  id: string;
  path: string;
  key: string;
  section: string;
  sectionLabel: string;
  label: string;
  labelKey: string;
  description: string;
  type: ConfigControlType;
  /** The untouched backend value, suitable for approval baselines. */
  value: unknown;
  /** A typed editor representation; rows and encoded booleans differ from value. */
  editorValue: unknown;
  options?: ConfigOption[];
  readOnly?: boolean;
  sensitive?: boolean;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  storage?: "string" | "number" | "boolean";
  ordered?: boolean;
  columns?: ConfigColumn[];
  allowAdd?: boolean;
  allowRemove?: boolean;
  defaultRow?: Record<string, unknown>;
  rowLabels?: string[];
  /** Serialization rules are data, so metadata can cross controller snapshots. */
  codec?:
    | "string-list"
    | "csv-selection"
    | "numeric-switch"
    | "friend-list"
    | "sweep-plan"
    | "explore-plan"
    | "counts"
    | "activity-counts";
  constraints?: {
    server?: string;
    mode?: "normal" | "hard";
    minChapter?: number;
    maxChapter?: number;
    length?: number;
    count?: number;
    adbAddress?: string;
    adbPort?: string;
    catalogRequired?: boolean;
  };
  language: string;
}
export interface ConfigurationOptions {
  language?: string;
  /** The backend's static resource, rather than names inferred from profile JSON. */
  staticData?: Record<string, any>;
  platform?: string;
}
export interface ConfigSection {
  id: string;
  label: string;
  description: string;
  fields: ConfigField[];
}

const locales: Record<string, unknown> = { en, zh, ja, ko, de, fr, ru };
const SECTIONS = [
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
  "server",
  "script",
  "emulator",
  "stage",
  "team",
  "push",
];
const SERVER_LABELS: [string, string][] = [
  ["官服", "server.cn.official"],
  ["B服", "server.cn.bilibili"],
  ["国际服", "server.global"],
  ["国际服青少年", "server.global.teen"],
  ["韩国ONE", "server.kr.one"],
  ["日服", "server.jp"],
  ["日服PC端", "server.jpPc"],
  ["Steam国际服", "server.globalPc"],
];
const SERVER_MODES: Record<string, string> = {
  官服: "CN",
  B服: "CN",
  国际服: "Global",
  国际服青少年: "Global",
  韩国ONE: "Global",
  日服: "JP",
  日服PC端: "JP",
  Steam国际服: "Global",
  CN: "CN",
  JP: "JP",
  Global: "Global",
};
const PROPERTY_KEYS: Record<string, string> = {
  burst: "property.burst",
  pierce: "property.pierce",
  mystic: "property.mystic",
  shock: "property.shock",
  Unused: "property.unused",
};
const DANGEROUS = new Set(["__proto__", "constructor", "prototype"]);

/** Read the same bundled catalogs and $self convention as desktop i18n. */
export function configurationText(
  key: string,
  language = "en",
  values: Record<string, unknown> = {}
): string {
  const locale = language.toLowerCase().split(/[-_.@]/)[0];
  const lookup = (root: unknown): string | undefined => {
    let current: any = root;
    for (const part of key.split("."))
      current = current && Object.hasOwn(current, part) ? current[part] : undefined;
    return typeof current === "string"
      ? current
      : typeof current?.$self === "string"
        ? current.$self
        : undefined;
  };
  return (lookup(locales[locale]) ?? lookup(en) ?? key).replace(
    /\{\{(\w+)\}\}/g,
    (whole, name: string) => String(values[name] ?? whole)
  );
}

function pointer(key: string): string {
  return `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}
function at(config: Record<string, unknown>, path: string): { exists: boolean; value: unknown } {
  let value: any = config;
  for (const part of path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (DANGEROUS.has(part) || !value || typeof value !== "object" || !Object.hasOwn(value, part))
      return { exists: false, value: undefined };
    value = value[part];
  }
  return { exists: true, value };
}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const unique = <T>(values: T[]): T[] => [...new Set(values)];

/** Explicitly mirrors the controls in ConfigurationPage's desktop feature panels. */
export function configurationFields(
  config: Record<string, any>,
  options: ConfigurationOptions = {}
): ConfigField[] {
  const language = options.language || "en",
    data = options.staticData || {},
    platform = options.platform || process.platform;
  const web = platform === "webui",
    android = platform === "android",
    windows = ["win32", "windows"].includes(platform);
  const t = (key: string, values?: Record<string, unknown>) =>
    configurationText(key, language, values);
  const server = String(config.server || ""),
    mode = SERVER_MODES[server] || "CN",
    pc = ["日服PC端", "Steam国际服"].includes(server);
  const fields: ConfigField[] = [];
  const opts = (values: readonly ConfigValue[], keys?: Record<string, string>): ConfigOption[] =>
    values.map((value) => ({
      value,
      label: keys?.[String(value)] ? t(keys[String(value)]) : String(value),
    }));
  const catalog = (
    values: unknown,
    selected: unknown,
    keys?: Record<string, string>
  ): ConfigOption[] => {
    const known = strings(values),
      saved = Array.isArray(selected)
        ? strings(selected)
        : typeof selected === "string" && selected
          ? [selected]
          : [];
    return unique([...known, ...saved]).map((value) => ({
      value,
      label: keys?.[value] ? t(keys[value]) : value,
      ...(!known.includes(value) ? { disabled: true } : {}),
    }));
  };
  type Extra = Partial<Omit<ConfigField, "path" | "section" | "type" | "labelKey">>;
  const add = (
    key: string,
    section: string,
    type: ConfigControlType,
    labelKey: string,
    descriptionKey = "",
    extra: Extra = {},
    condition = true
  ) => {
    const path = key.startsWith("/") ? key : pointer(key),
      current = at(config, path);
    if (!condition || !current.exists) return;
    fields.push({
      id: path,
      path,
      key: path.slice(1).split("/")[0],
      section,
      sectionLabel: t(section),
      labelKey,
      label: t(labelKey),
      description: descriptionKey ? t(descriptionKey) : "",
      type,
      value: structuredClone(current.value),
      editorValue: structuredClone(current.value),
      language,
      ...extra,
    });
  };
  const toggle = (key: string, section: string, label: string, help = "", condition = true) =>
    add(key, section, "switch", label, help, { storage: "boolean" }, condition);
  const number = (
    key: string,
    section: string,
    label: string,
    help: string,
    min: number,
    max?: number,
    extra: Extra = {},
    condition = true
  ) =>
    add(
      key,
      section,
      "number",
      label,
      help,
      { min, max, integer: true, storage: "number", ...extra },
      condition
    );
  const select = (
    key: string,
    section: string,
    label: string,
    values: ConfigOption[],
    help = "",
    extra: Extra = {},
    condition = true
  ) => add(key, section, "select", label, help, { options: values, ...extra }, condition);
  const studentNames = Array.isArray(data.student_names)
    ? data.student_names.flatMap((student: unknown) => {
        if (typeof student === "string") return [student];
        if (!student || typeof student !== "object") return [];
        const name = (student as Record<string, unknown>)[`${mode}_name`];
        return typeof name === "string" ? [name] : [];
      })
    : [];
  const students = (key: string, section: string, label: string, help: string, condition = true) =>
    add(
      key,
      section,
      "list",
      label,
      help,
      {
        codec: "string-list",
        ordered: true,
        allowAdd: true,
        allowRemove: true,
        options: catalog(studentNames, config[key]),
      },
      condition
    );

  // Server is deliberately immutable in desktop ServerConfig. PC profiles have no ADB controls.
  select(
    "server",
    "server",
    "server.server",
    SERVER_LABELS.map(([value, key]) => ({ value, label: t(key) })),
    "configurationHelp.server",
    { readOnly: true }
  );
  add(
    "adbIP",
    "server",
    "text",
    "server.adbIP",
    "configurationHelp.adbAddress",
    { constraints: { adbPort: String(config.adbPort || "") } },
    !pc
  );
  add(
    "adbPort",
    "server",
    String(config.adbIP || "").trim() ? "number" : "text",
    "server.adbPort",
    "configurationHelp.adbPort",
    {
      min: 0,
      max: 65535,
      integer: true,
      storage: "string",
      constraints: { adbAddress: String(config.adbIP || "") },
    },
    !pc
  );

  toggle("autostart", "script", "script.autostart", "configurationHelp.scriptAutostart");
  select(
    "then",
    "script",
    "script.then",
    opts(["无动作", "退出 Baas", "退出 模拟器", "退出 Baas 和 模拟器", "关机"], {
      无动作: "script.doNothing",
      "退出 Baas": "script.exitBaas",
      "退出 模拟器": "script.exitEmu",
      "退出 Baas 和 模拟器": "script.exitBoth",
      关机: "script.shutdown",
    }),
    "configurationHelp.scriptThen",
    {},
    !web
  );
  number(
    "screenshot_interval",
    "script",
    "script.screenshotInterval",
    "configurationHelp.screenshotInterval",
    0.1,
    undefined,
    { integer: false, step: 0.1, storage: "string" }
  );
  for (const kind of ["screenshot", "control"] as const) {
    const key = `${kind}_method`,
      allowed = pc
        ? kind === "screenshot"
          ? ["mss", "pyautogui"]
          : ["pyautogui"]
        : strings(data[`${kind}_methods`]).length
          ? strings(data[`${kind}_methods`])
          : kind === "screenshot"
            ? ["adb", "uiautomator2", "scrcpy", "nemu", "mss", "pyautogui"]
            : ["adb", "uiautomator2", "scrcpy", "nemu", "pyautogui"];
    const values = catalog(allowed, config[key]).map((option) => ({
      ...option,
      label:
        (
          { adb: "ADB", nemu: "Nemu", mss: "MSS", pyautogui: "PyAutoGUI" } as Record<string, string>
        )[String(option.value)] || option.label,
      disabled:
        option.disabled ||
        (web && ["nemu", "mss", "pyautogui", "android_local"].includes(String(option.value))),
    }));
    select(
      key,
      "script",
      `script.${kind}Method`,
      values,
      `configurationHelp.${kind}Method`,
      { readOnly: pc && !windows },
      !android
    );
  }

  for (const [key, label, help] of [
    ["cafe_reward_collect_hour_reward", "cafe.collectReward", "cafeCollectReward"],
    ["cafe_reward_use_invitation_ticket", "cafe.useInvitation", "cafeUseInvitation"],
    ["cafe_reward_allow_exchange_student", "cafe.exchangeStudent", "cafeExchangeStudent"],
    ["cafe_reward_allow_duplicate_invite", "cafe.duplicateInvite", "cafeDuplicateInvite"],
    ["cafe_reward_has_no2_cafe", "cafe.hasNo2Cafe", "cafeSecondCafe"],
  ])
    toggle(key, "cafe", label, `configurationHelp.${help}`);
  number(
    "cafe_reward_affection_pat_round",
    "cafe",
    "cafe.patRounds",
    "description.cafe.patRounds",
    4,
    15
  );
  select(
    "patStyle",
    "cafe",
    "cafe.patStyle",
    opts(["普通", "拖动礼物"], {
      普通: "configurationHelp.cafePatNormal",
      拖动礼物: "cafe.patStyleDragGift",
    }),
    "configurationHelp.cafePatStyle"
  );
  number(
    "cafe_reward_interaction_shot_delay",
    "cafe",
    "cafe.interactionShotDelay",
    "configurationHelp.cafeInteractionShotDelay",
    0,
    undefined,
    { integer: false },
    config.patStyle === "拖动礼物"
  );
  for (const cafe of [1, 2]) {
    const show = cafe === 1 || config.cafe_reward_has_no2_cafe === true,
      key = `cafe_reward_invite${cafe}_criterion`;
    select(
      key,
      "cafe",
      `cafe.invite${cafe}Mode`,
      opts(["lowest_affection", "highest_affection", "starred", "name"], {
        lowest_affection: "cafe.lowestAffection",
        highest_affection: "cafe.highestAffection",
        starred: "cafe.starred",
        name: "cafe.byName",
      }),
      "configurationHelp.cafeInviteMode",
      {},
      show
    );
    select(
      `cafe_reward_invite${cafe}_starred_student_position`,
      "cafe",
      "cafe.starredPosition",
      opts([1, 2, 3, 4, 5]),
      "configurationHelp.cafeStarredPosition",
      { storage: "number" },
      show && config[key] === "starred"
    );
    students(
      `favorStudent${cafe}`,
      "cafe",
      `cafe.cafe${cafe}Students`,
      "configurationHelp.cafeStudents",
      show && config[key] === "name"
    );
  }

  toggle(
    "lesson_enableInviteFavorStudent",
    "schedule",
    "lesson.enableFavorStudent",
    "configurationHelp.lessonFavorEnabled"
  );
  toggle(
    "lesson_relationship_first",
    "schedule",
    "lesson.relationshipFirst",
    "configurationHelp.lessonRelationshipFirst"
  );
  students(
    "lesson_favorStudent",
    "schedule",
    "lesson.favorStudent",
    "configurationHelp.lessonFavorOrder",
    config.lesson_enableInviteFavorStudent === true
  );
  const lessonNames = strings(data.lesson_region_name?.[mode === "Global" ? "Global_en-us" : mode]);
  const levels = ["primary", "normal", "advanced", "superior"];
  if (Array.isArray(config.lesson_times))
    config.lesson_times.forEach((_: unknown, index: number) => {
      const region = lessonNames[index] || `${t("lesson.region")} ${index + 1}`;
      number(
        `/lesson_times/${index}`,
        "schedule",
        "lesson.times",
        "configurationHelp.lessonRegionTableHint",
        0,
        99,
        { label: `${region} · ${t("lesson.times")}` }
      );
    });
  if (Array.isArray(config.lesson_each_region_object_priority))
    config.lesson_each_region_object_priority.forEach((value: unknown, index: number) => {
      add(
        `/lesson_each_region_object_priority/${index}`,
        "schedule",
        "multiselect",
        "lesson.region",
        "configurationHelp.lessonRegionTableHint",
        {
          label: lessonNames[index] || `${t("lesson.region")} ${index + 1}`,
          options: opts(
            levels,
            Object.fromEntries(levels.map((level) => [level, `schedule.${level}`]))
          ),
          ordered: true,
        }
      );
    });

  for (const [list, refresh, label, catalogKey] of [
    ["CommonShopList", "CommonShopRefreshTime", "commonShop.title", "common_shop_price_list"],
    [
      "TacticalChallengeShopList",
      "TacticalChallengeShopRefreshTime",
      "tacticalShop.title",
      "tactical_challenge_shop_price_list",
    ],
  ]) {
    number(refresh, "shop", "commonShop.refreshTimes", "description.commonShop.refresh", 0, 5, {
      label: `${t(label)} · ${t("commonShop.refreshTimes")}`,
    });
    if (Array.isArray(config[list]))
      config[list].forEach((value: unknown, index: number) => {
        const goods = data[catalogKey]?.[mode]?.[index];
        add(`/${list}/${index}`, "shop", "switch", label, "", {
          label: Array.isArray(goods) ? String(goods[0]) : `${t(label)} ${index + 1}`,
          description: Array.isArray(goods)
            ? `${goods[1]} ${t(({ creditpoints: "property.credits", pyroxene: "property.pyroxene", tactical_challenge_coin: "property.coin.arena", bounty_coin: "property.coin.commission" } as Record<string, string>)[goods[2] || "tactical_challenge_coin"] || String(goods[2]))}`
            : "",
          codec: "numeric-switch",
          editorValue: value === 1,
          storage: "number",
        });
      });
  }

  toggle(
    "use_acceleration_ticket",
    "artifact",
    "description.artifact.useTicket",
    "configurationHelp.artifactUseTicket"
  );
  number(
    "createTime",
    "artifact",
    "artifact.createTime",
    "configurationHelp.artifactCreateTimes",
    1,
    10,
    { storage: "string" }
  );
  select(
    "create_phase",
    "artifact",
    "artifact.phaseCount",
    opts([1, 2, 3]),
    "configurationHelp.artifactPhases",
    { storage: "number" }
  );
  const materialKeys = {
    default: "artifact.default",
    primary: "artifact.white",
    normal: "artifact.blue",
    primary_normal: "artifact.whiteBlue",
    advanced: "artifact.gold",
    superior: "artifact.purple",
    advanced_superior: "artifact.goldPurple",
    primary_normal_advanced_superior: "artifact.all",
  };
  for (const phase of [1, 2, 3]) {
    const show = phase <= Number(config.create_phase || 1),
      priorityKey = `createPriority_phase${phase}`;
    select(
      `create_phase_${phase}_select_item_rule`,
      "artifact",
      "artifact.materialSelect",
      opts(
        phase === 1
          ? ["default"]
          : phase === 2
            ? [
                "primary",
                "normal",
                "primary_normal",
                "advanced",
                "superior",
                "advanced_superior",
                "primary_normal_advanced_superior",
              ]
            : ["advanced", "superior", "advanced_superior"],
        materialKeys
      ),
      "configurationHelp.artifactMaterialRule",
      { label: `${t(`artifact.phase${phase}`)} · ${t("artifact.materialSelect")}` },
      show
    );
    const selected = Array.isArray(config[priorityKey])
      ? config[priorityKey]
      : typeof config[priorityKey] === "string"
        ? config[priorityKey]
            .split(">")
            .map((entry: string) => entry.trim())
            .filter(Boolean)
        : [];
    add(
      priorityKey,
      "artifact",
      "list",
      "artifact.priority",
      "friendlyPriority.reorderHint",
      {
        label: `${t(`artifact.phase${phase}`)} · ${t("artifact.priority")}`,
        codec: "string-list",
        editorValue: selected,
        ordered: true,
        allowAdd: true,
        allowRemove: true,
        options: catalog(data.create_default_priority?.[mode]?.[`phase${phase}`], selected),
      },
      show
    );
  }

  toggle(
    "ArenaStopFightWhenRank1",
    "arena",
    "arena.stopAtFirstPlace",
    "configurationHelp.arenaStopAtFirstPlace"
  );
  number("ArenaLevelDiff", "arena", "arena.higherLevel", "configurationHelp.arenaLevel", -89, 89);
  number(
    "maxArenaRefreshTimes",
    "arena",
    "arena.maxRefreshTimes",
    "configurationHelp.arenaRefresh",
    0
  );
  select(
    "ArenaComponentNumber",
    "arena",
    "arena.opponentNo",
    opts([1, 2, 3]),
    "configurationHelp.arenaOpponent",
    { storage: "number" }
  );
  const difficultyKeys = {
    NORMAL: "configurationDifficulties.normal",
    HARD: "configurationDifficulties.hard",
    VERYHARD: "configurationDifficulties.veryHard",
    HARDCORE: "configurationDifficulties.hardcore",
    EXTREME: "configurationDifficulties.extreme",
    INSANE: "configurationDifficulties.insane",
    TORMENT: "configurationDifficulties.torment",
  };
  select(
    "totalForceFightDifficulty",
    "tactical",
    "tactical.hardLevel",
    catalog(
      data.total_assault_difficulties?.[mode] || Object.keys(difficultyKeys),
      config.totalForceFightDifficulty,
      difficultyKeys
    ),
    "configurationHelp.tacticalDifficulty"
  );
  select(
    "final_restriction_rls_employ_formation_method",
    "finalRestrictionRls",
    "finalRestrictionRls.formationMethod",
    opts(["default", "copy_clear_unit"], {
      default: "finalRestrictionRls.useCurrentFormation",
      copy_clear_unit: "finalRestrictionRls.copyClearFormation",
    }),
    "configurationHelp.finalMethod"
  );
  const copyDisabled = config.final_restriction_rls_employ_formation_method !== "copy_clear_unit";
  number(
    "final_restriction_rls_employ_formation_copy_clear_unit_max_unavailable_student_count",
    "finalRestrictionRls",
    "finalRestrictionRls.maxUnavailableStudentCount",
    "configurationHelp.finalUnavailable",
    0,
    10,
    { readOnly: copyDisabled }
  );
  number(
    "final_restriction_rls_employ_formation_copy_clear_unit_max_refresh_count",
    "finalRestrictionRls",
    "finalRestrictionRls.maxRefreshCount",
    "configurationHelp.finalRefresh",
    0,
    undefined,
    { readOnly: copyDisabled }
  );
  toggle("drill_enable_sweep", "drill", "drill.useAllAfterSweep", "configurationHelp.drillSweep");
  for (const [key, label, help] of [
    ["drill_fight_formation_list", "drill.outPartyNo", "drillFormation"],
    ["drill_difficulty_list", "drill.difficulty", "drillDifficulty"],
  ]) {
    if (Array.isArray(config[key]))
      config[key].forEach((_: unknown, index: number) =>
        select(
          `/${key}/${index}`,
          "drill",
          label,
          opts([1, 2, 3, 4]),
          `configurationHelp.${help}`,
          { label: `${t(label)} ${index + 1}`, storage: "number" }
        )
      );
  }
  for (const [key, label, help] of [
    ["clear_friend_level_limit", "friend.levelLimit", "friendLevel"],
    ["clear_friend_last_login_time_days", "friend.lastLoginDays", "friendLogin"],
    [
      "clear_friend_last_total_assault_rank_limit",
      "friend.lastTotalAssaultRankLimit",
      "friendRank",
    ],
  ])
    number(key, "whitelist", label, `configurationHelp.${help}`, -1);
  add(
    "clear_friend_white_list",
    "whitelist",
    "list",
    "friend.whitelist",
    "configurationHelp.friendWhitelist",
    { codec: "friend-list", allowAdd: true, allowRemove: true, constraints: { server: mode } }
  );

  for (const [key, label, help] of [
    ["open_emulator_stat", "emulator.openOnLaunch", "emulatorLaunch"],
    ["emulatorIsMultiInstance", "emulator.multiInstance", "emulatorMulti"],
  ])
    toggle(key, "emulator", label, `configurationHelp.${help}`);
  number(
    "emulator_wait_time",
    "emulator",
    "emulator.waitTime",
    "configurationHelp.emulatorWait",
    0,
    undefined,
    { integer: false, storage: "string" }
  );
  add("program_address", "emulator", "text", "emulator.address", "configurationHelp.emulatorPath");
  select(
    "multiEmulatorName",
    "emulator",
    "emulator.multiType",
    opts(
      [
        "mumu",
        "mumu_global",
        "bluestacks_nxt_cn",
        "bluestacks_nxt",
        "yeshen",
        "xiaoyao_nat",
        "leidian",
        "wsa",
      ],
      {
        mumu: "emulator.types.mumu",
        mumu_global: "emulator.types.mumuGlobal",
        bluestacks_nxt_cn: "emulator.types.bluestacksCn",
        bluestacks_nxt: "emulator.types.bluestacksGlobal",
        yeshen: "emulator.types.yeshen",
        xiaoyao_nat: "emulator.types.xiaoyaoNat",
        leidian: "emulator.types.leidian",
        wsa: "emulator.types.wsa",
      }
    )
  );
  number(
    "emulatorMultiInstanceNumber",
    "emulator",
    "emulator.instanceCount",
    "configurationHelp.emulatorInstance",
    0,
    undefined,
    {},
    config.emulatorIsMultiInstance === true
  );

  toggle("manual_boss", "stage", "stage.manualBoss", "configurationHelp.manualBoss");
  toggle(
    "explore_task_use_simple_mode",
    "stage",
    "stage.simpleMode",
    "configurationHelp.exploreSimpleMode"
  );
  for (const kind of ["normal", "hard"] as const) {
    const key = `explore_${kind}_task_list`,
      saved = typeof config[key] === "string" ? parseExplorePlan(config[key]) : [],
      minimum = Math.max(
        1,
        Number(data[`explore_${kind}_task_region_range`]?.[0]) || (kind === "normal" ? 4 : 1)
      ),
      maximum = Math.max(
        minimum,
        Math.min(
          250,
          Number(data[`explore_${kind}_task_region_range`]?.[1]) || 30,
          Number(data.max_region?.[mode]) || 30
        )
      );
    add(key, "stage", "rows", `stage.${kind}Task`, "configurationHelp.manualBoss", {
      codec: "explore-plan",
      editorValue: saved.map((entry) => ({
        chapter: entry.chapter ?? entry.raw,
        mission: entry.mission ?? "all",
      })),
      columns: [
        {
          key: "chapter",
          label: t("friendlyPriority.chapter"),
          type: "number",
          min: minimum,
          max: maximum,
          integer: true,
        },
        {
          key: "mission",
          label: t("friendlyPriority.mission"),
          type: "select",
          options: [
            { value: "all", label: t("friendlyPriority.wholeChapter") },
            ...opts(kind === "normal" ? ["1", "2", "3", "4", "5", "A"] : ["1", "2", "3"]),
          ],
        },
      ],
      allowAdd: true,
      allowRemove: true,
      ordered: true,
      defaultRow: { chapter: minimum, mission: "all" },
      constraints: { mode: kind, minChapter: minimum, maxChapter: maximum },
    });
  }
  const episodes = Array.isArray(data.main_story_available_episodes?.[mode])
    ? data.main_story_available_episodes[mode].filter(
        (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0
      )
    : [];
  const savedEpisodes =
    typeof config.main_story_regions === "string" && config.main_story_regions.trim()
      ? config.main_story_regions.split(",").map((value: string) => value.trim())
      : [];
  add(
    "main_story_regions",
    "stage",
    "multiselect",
    "stage.mainStoryEpisodes",
    "configurationHelp.mainStoryEpisodes",
    {
      codec: "csv-selection",
      editorValue: savedEpisodes,
      options: episodes.map((value: number) => ({ value: String(value), label: String(value) })),
      ordered: true,
      constraints: { catalogRequired: true },
    }
  );
  select(
    "choose_team_method",
    "team",
    "team.chooseMethod",
    opts(["preset", "side", "order"], {
      preset: "team.preset",
      side: "team.side",
      order: "team.order",
    }),
    "configurationHelp.teamMethod"
  );
  for (const choice of ["preset", "side"]) {
    const key = `${choice}_team_attribute`;
    if (config.choose_team_method === choice && Array.isArray(config[key]))
      config[key].forEach((row: unknown, index: number) => {
        if (Array.isArray(row))
          row.forEach((_: unknown, column: number) =>
            select(
              `/${key}/${index}/${column}`,
              "team",
              `team.${choice}`,
              opts(Object.keys(PROPERTY_KEYS), PROPERTY_KEYS),
              `configurationHelp.team${choice === "preset" ? "Preset" : "Side"}`,
              { label: `${t(`team.${choice}`)} ${index + 1} / ${column + 1}` }
            )
          );
      });
  }

  for (const [key, label, help] of [
    ["push_after_error", "push.afterError", "pushError"],
    ["push_after_completion", "push.afterCompletion", "pushCompletion"],
  ])
    toggle(key, "push", label, `configurationHelp.${help}`);
  for (const [key, label, help, secret] of [
    ["push_json", "push.json", "pushJson", true],
    ["push_serverchan", "push.serverchan", "pushServerchan", true],
    ["push_feishu", "push.feishu", "pushFeishu", true],
    ["push_wecom", "push.wecom", "pushWecom", true],
    ["push_telegram_bot_token", "push.telegramToken", "pushTelegramToken", true],
    ["push_telegram_chat_id", "push.telegramChatId", "pushTelegramChatId", false],
    ["push_telegram_proxy", "push.telegramProxy", "pushTelegramProxy", true],
    ["push_telegram_api", "push.telegramApi", "pushTelegramApi", false],
  ] as const)
    add(key, "push", "text", label, `configurationHelp.${help}`, { sensitive: secret });

  for (const [key, kind, label] of [
    ["mainlinePriority", "normal", "stage.normalLabel"],
    ["hardPriority", "hard", "stage.hardLabel"],
  ] as const) {
    const maxChapter = data[`explore_${kind}_task_region_range`]?.[1],
      parsed = parseSweepPlan(config[key], { mode: kind, server: mode, maxChapter });
    add(
      key,
      "dailySweep",
      "rows",
      label,
      `configurationHelp.${kind === "normal" ? "normal" : "hard"}SweepPlan`,
      {
        codec: "sweep-plan",
        editorValue: parsed.map((entry) =>
          entry.kind === "stage"
            ? {
                chapter: entry.chapter,
                mission: entry.mission,
                count: entry.count === "max" ? 3 : entry.count,
                maximum: entry.count === "max",
              }
            : { chapter: entry.raw, mission: 1, count: 0, maximum: false }
        ),
        columns: [
          {
            key: "chapter",
            label: t("sweepPlan.chapter"),
            type: "number",
            min: 1,
            max: maxChapter,
            integer: true,
          },
          {
            key: "mission",
            label: t("sweepPlan.mission"),
            type: "number",
            min: 1,
            max: kind === "normal" ? 5 : 3,
            integer: true,
          },
          {
            key: "maximum",
            label: t("sweepPlan.countMode"),
            type: "select",
            options: [
              { value: false, label: t("configurationCounts.fixed") },
              ...(sweepPlanAllowsMax(kind, mode)
                ? [{ value: true, label: t("sweepPlan.maximum") }]
                : []),
            ],
          },
          { key: "count", label: t("sweepPlan.count"), type: "number", min: 0, integer: true },
        ],
        allowAdd: true,
        allowRemove: true,
        ordered: true,
        defaultRow: { chapter: 1, mission: 1, count: 3, maximum: false },
        constraints: { mode: kind, server: mode, maxChapter },
      }
    );
  }
  for (const [key, label, count] of [
    ["rewarded_task_times", "sweep.rewarded", rewardedTaskRegionCount(server)],
    ["scrimmage_times", "sweep.scrimmage", 3],
    ["special_task_times", "sweep.special", 2],
  ] as const) {
    const tokens = typeof config[key] === "string" ? config[key].split(",") : [];
    add(key, "dailySweep", "rows", label, "configurationCounts.countHint", {
      codec: "counts",
      editorValue: Array.from({ length: count }, (_, index) => ({
        mode:
          tokens[index]?.trim() === "max"
            ? "all"
            : Number(tokens[index] || 0) <= 0
              ? "skip"
              : "count",
        amount: tokens[index]?.trim() === "max" ? 1 : Number(tokens[index] || 0),
      })),
      columns: [
        {
          key: "mode",
          label: t("configurationCounts.mode"),
          type: "select",
          options: opts(["skip", "count", "all"], {
            skip: "configurationCounts.skip",
            count: "configurationCounts.fixed",
            all: "configurationCounts.all",
          }),
        },
        {
          key: "amount",
          label: t("configurationCounts.amount"),
          type: "number",
          min: 0,
          integer: true,
        },
      ],
      rowLabels:
        key === "rewarded_task_times"
          ? count === 3
            ? ["bountyOverpass", "bountyRailroad", "bountyClassroom"].map((key) =>
                t(`configurationCounts.${key}`)
              )
            : Array.from({ length: count }, (_, index) =>
                t("sweep.rewardedRegion", { number: index + 1 })
              )
          : (key === "scrimmage_times"
              ? ["scrimmageTrinity", "scrimmageGehenna", "scrimmageMillennium"]
              : ["specialDefense", "specialRetrieval"]
            ).map((key) => t(`configurationCounts.${key}`)),
      allowAdd: false,
      allowRemove: false,
      constraints: { length: count },
    });
  }
  add(
    "activity_sweep_times",
    "dailySweep",
    "rows",
    "sweep.activityTimes",
    "configurationCounts.activityHint",
    {
      codec: "activity-counts",
      editorValue:
        readActivitySweepCounts(config.activity_sweep_times)?.map((count) => ({
          mode: count.mode,
          amount: count.amount,
        })) ?? [],
      columns: [
        {
          key: "mode",
          label: t("configurationCounts.mode"),
          type: "select",
          options: opts(["skip", "count", "share", "all"], {
            skip: "configurationCounts.skip",
            count: "configurationCounts.fixed",
            share: "configurationCounts.share",
            all: "configurationCounts.allActivity",
          }),
        },
        {
          key: "amount",
          label: t("configurationCounts.amount"),
          type: "number",
          min: 0,
          integer: false,
        },
      ],
      allowAdd: true,
      allowRemove: true,
      defaultRow: { mode: "skip", amount: 0 },
    }
  );
  const missions = data.current_game_activity?.[mode]?.mission;
  const activityStages: number[] =
    !missions || typeof missions !== "object"
      ? []
      : Array.isArray(missions)
        ? missions.map((_: unknown, index: number) => index + 1)
        : [
            ...new Set<number>(
              Object.keys(missions).flatMap((key) => {
                const match = /^(?:任务|mission)?\s*(\d+)$/i.exec(key);
                const number = match ? Number(match[1]) : NaN;
                return Number.isSafeInteger(number) && number > 0 ? [number] : [];
              })
            ),
          ].sort((left, right) => left - right);
  if (activityStages.length) {
    const stageOptions: ConfigOption[] = activityStages.map((number) => ({
      value: number,
      label: t("friendlyBounty.activityStageOption", { number }),
    }));
    const savedStage = config.activity_sweep_task_number;
    if (Number.isSafeInteger(savedStage) && savedStage > 0 && !activityStages.includes(savedStage))
      stageOptions.push({
        value: savedStage,
        label: t("friendlyBounty.activityStageSaved", { number: savedStage }),
      });
    select(
      "activity_sweep_task_number",
      "dailySweep",
      "sweep.activityNumber",
      stageOptions,
      "configurationCounts.activityHint"
    );
  } else {
    number(
      "activity_sweep_task_number",
      "dailySweep",
      "sweep.activityNumber",
      "configurationCounts.activityHint",
      1
    );
  }
  for (const [key, label, maximum] of [
    ["purchase_rewarded_task_ticket_times", "sweep.purchaseRewarded", 12],
    ["purchase_lesson_ticket_times", "sweep.purchaseLesson", 4],
    ["purchase_scrimmage_ticket_times", "sweep.purchaseScrimmage", 12],
  ] as const)
    select(
      key,
      "dailySweep",
      label,
      [
        { value: "max", label: t("configurationCounts.maximumPurchases") },
        ...Array.from({ length: maximum + 1 }, (_, number) => ({
          value: String(number),
          label: number === 0 ? t("configurationCounts.skip") : String(number),
        })),
      ],
      `configurationHelp.${key === "purchase_lesson_ticket_times" ? "sweepPurchaseLesson" : key === "purchase_scrimmage_ticket_times" ? "sweepPurchaseScrimmage" : "sweepPurchaseRewarded"}`
    );

  return fields
    .filter((field) => field.section !== "emulator" || !["webui", "android"].includes(platform))
    .sort((left, right) => SECTIONS.indexOf(left.section) - SECTIONS.indexOf(right.section));
}

export function configurationSections(
  config: Record<string, any>,
  options: ConfigurationOptions = {}
): ConfigSection[] {
  const fields = configurationFields(config, options);
  return SECTIONS.flatMap((id) => {
    const selected = fields.filter((field) => field.section === id);
    return selected.length
      ? [
          {
            id,
            label: selected[0].sectionLabel,
            description: configurationText(`description.${id}`, options.language),
            fields: selected,
          },
        ]
      : [];
  });
}

export function getConfigurationField(
  config: Record<string, any>,
  path: string,
  options: ConfigurationOptions = {}
): ConfigField | undefined {
  return configurationFields(config, options).find((field) => field.path === path);
}

export class ConfigurationValueError extends Error {
  constructor(
    readonly code: "not_editable" | "type" | "range" | "option" | "format",
    message: string
  ) {
    super(message);
    this.name = "ConfigurationValueError";
  }
}

function invalid(
  field: ConfigField,
  code: ConfigurationValueError["code"] = "format",
  key = "plugins.invalidValue"
): never {
  throw new ConfigurationValueError(
    code,
    `${field.label}: ${configurationText(key, field.language)}`
  );
}

/** Accept control values, never JSON text masquerading as a checkbox, select or number. */
export function parseConfigurationValue(field: ConfigField, input: unknown): unknown {
  if (field.readOnly) invalid(field, "not_editable", "configurationHelp.backendUpdateRequired");
  const numeric = (
    value: unknown,
    definition: { min?: number; max?: number; integer?: boolean } = field
  ): number => {
    if (
      typeof value !== "number" &&
      (typeof value !== "string" ||
        !value.trim() ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
    )
      invalid(field, "type");
    const number = Number(value);
    if (
      !Number.isFinite(number) ||
      (definition.integer && !Number.isSafeInteger(number)) ||
      (definition.min !== undefined && number < definition.min) ||
      (definition.max !== undefined && number > definition.max)
    )
      invalid(field, "range");
    return number;
  };
  const accepted = (value: unknown): ConfigValue => {
    const option = field.options?.find(
      (option) =>
        !option.disabled &&
        (Object.is(option.value, value) ||
          (typeof value === "string" &&
            typeof option.value === "number" &&
            String(option.value) === value))
    );
    if (!option) invalid(field, "option");
    return option.value;
  };
  const text = (value: unknown): string => {
    if (
      typeof value !== "string" ||
      [...value].some((character) => {
        const code = character.charCodeAt(0);
        return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159);
      }) ||
      value.includes(REDACTED)
    )
      invalid(field, "type");
    return value;
  };
  if (field.type === "switch") {
    if (typeof input !== "boolean") invalid(field, "type");
    return field.codec === "numeric-switch" ? Number(input) : input;
  }
  if (field.type === "number") {
    if (field.key === "adbPort" && input === "") {
      if (!field.constraints?.adbAddress?.trim()) invalid(field);
      return "";
    }
    const value = numeric(input);
    return field.storage === "string" ? String(value) : value;
  }
  if (field.type === "select") return accepted(input);
  if (field.type === "text") {
    const value = text(input);
    if (field.key === "adbIP" || field.key === "adbPort") {
      if (!value.trim() && !(field.constraints?.adbPort || field.constraints?.adbAddress)?.trim())
        invalid(field);
      if (field.key === "adbIP" && value.trim() && field.constraints?.adbPort?.trim())
        numeric(field.constraints.adbPort.trim(), { min: 0, max: 65535, integer: true });
      return value.trim();
    }
    return value;
  }
  if (field.type === "multiselect" || field.type === "list") {
    if (!Array.isArray(input) || input.length > 2000) invalid(field, "type");
    const values = input.map((value) => text(value));
    if (unique(values).length !== values.length) invalid(field, "format");
    if (field.codec === "friend-list") {
      for (const value of values) {
        if (value.length !== (field.constraints?.server === "CN" ? 7 : 8))
          invalid(field, "format", "friend.invalidLength");
        if (field.constraints?.server === "CN" && !/^[0-9a-z]+$/.test(value))
          invalid(field, "format", "friend.invalidFormatCN");
        if (field.constraints?.server === "Global" && !/^[A-Z]+$/.test(value))
          invalid(field, "format", "friend.invalidFormatGlobal");
      }
    } else if (field.options) {
      const saved = Array.isArray(field.editorValue) ? field.editorValue : [];
      for (const value of values) {
        // Unknown imported entries remain retainable/removable, but cannot be newly introduced.
        if (
          !field.options.some((option) => option.value === value && !option.disabled) &&
          !(field.codec !== "csv-selection" && saved.includes(value))
        )
          invalid(field, "option");
      }
    } else if (values.some((value) => !value.trim())) invalid(field, "format");
    if (field.codec === "csv-selection") {
      if (values.some((value) => !/^[1-9]\d*$/.test(value))) invalid(field, "format");
      return values.join(",");
    }
    return values;
  }
  if (field.type === "rows") {
    if (
      !Array.isArray(input) ||
      input.length > 2000 ||
      input.some((row) => !row || typeof row !== "object" || Array.isArray(row))
    )
      invalid(field, "type");
    const rows = input as Record<string, unknown>[];
    if (field.constraints?.length !== undefined && rows.length !== field.constraints.length)
      invalid(field, "format");
    for (const row of rows)
      if (Object.keys(row).some((key) => !field.columns?.some((column) => column.key === key)))
        invalid(field, "format");
    if (field.codec === "sweep-plan") {
      if (rows.some((row) => row.maximum !== undefined && typeof row.maximum !== "boolean"))
        invalid(field, "type");
      const source = rows
        .map(
          (row) =>
            `${numeric(row.chapter, { min: 1, max: field.constraints?.maxChapter, integer: true })}-${numeric(row.mission, { min: 1, max: field.constraints?.mode === "hard" ? 3 : 5, integer: true })}-${row.maximum === true ? "max" : numeric(row.count, { min: 0, integer: true })}`
        )
        .join(", ");
      const parsed = parseSweepPlan(source, field.constraints);
      if (parsed.some((entry) => entry.kind !== "stage")) invalid(field, "format");
      return serializeSweepPlan(parsed);
    }
    if (field.codec === "explore-plan") {
      return rows
        .map((row) => {
          const chapter = numeric(row.chapter, {
            min: field.constraints?.minChapter ?? 1,
            max: field.constraints?.maxChapter,
            integer: true,
          });
          const entry = createExplorePlanEntry(
            chapter,
            text(String(row.mission)),
            field.constraints?.mode || "normal"
          );
          if (!entry) invalid(field, "format");
          return entry.raw;
        })
        .join(",");
    }
    const result = rows
      .map((row) => {
        if (field.codec === "counts") {
          if (row.mode === "skip") return "0";
          if (row.mode === "all") return "max";
          if (row.mode !== "count") return invalid(field, "option");
          return String(numeric(row.amount, { min: 0, integer: true }));
        }
        if (row.mode === "all" && rows.length !== 1) invalid(field, "format");
        if (!["skip", "count", "share", "all"].includes(String(row.mode))) invalid(field, "option");
        const amount =
          row.mode === "skip" || row.mode === "all"
            ? "1"
            : String(
                numeric(row.amount, {
                  min: row.mode === "share" ? 0 : 1,
                  max: row.mode === "share" ? 100 : undefined,
                  integer: row.mode === "count",
                })
              );
        const token = activitySweepCountToken(
          row.mode as "skip" | "count" | "share" | "all",
          amount
        );
        if (token === null) invalid(field, "format");
        return token;
      })
      .join(",");
    if (field.codec === "activity-counts") {
      if (!isActivitySweepCountStringValid(result)) invalid(field, "format");
    } else if (
      !isSweepCountStringValid(result, field.constraints?.length || 0) ||
      result.split(",").some((value) => value.trim() !== "max" && !/^\d+$/.test(value.trim()))
    )
      invalid(field, "format");
    return result;
  }
  return invalid(field, "type");
}

export function validateConfigurationChange(
  config: Record<string, any>,
  path: string,
  input: unknown,
  options: ConfigurationOptions = {}
): unknown {
  const field = getConfigurationField(config, path, options);
  if (!field)
    throw new ConfigurationValueError(
      "not_editable",
      configurationText("plugins.invalidValue", options.language)
    );
  return parseConfigurationValue(field, input);
}

/** Validate an already serialized command value at the mutation boundary. */
export function validateConfigurationStoredValue(
  config: Record<string, any>,
  path: string,
  value: unknown,
  options: ConfigurationOptions = {}
): unknown {
  const field = getConfigurationField(config, path, options);
  if (!field)
    throw new ConfigurationValueError(
      "not_editable",
      configurationText("plugins.invalidValue", options.language)
    );
  let input = value;
  if (field.codec === "numeric-switch") {
    if (value !== 0 && value !== 1) invalid(field, "type");
    input = value === 1;
  } else if (field.codec === "csv-selection") {
    if (typeof value !== "string") invalid(field, "type");
    input = value.trim() ? value.split(",").map((value) => value.trim()) : [];
  } else if (field.codec === "sweep-plan") {
    if (typeof value !== "string") invalid(field, "type");
    input = parseSweepPlan(value, field.constraints).map((entry) => {
      if (entry.kind !== "stage") return invalid(field, "format");
      return {
        chapter: entry.chapter,
        mission: entry.mission,
        count: entry.count === "max" ? 3 : entry.count,
        maximum: entry.count === "max",
      };
    });
  } else if (field.codec === "explore-plan") {
    if (typeof value !== "string") invalid(field, "type");
    input = parseExplorePlan(value).map((entry) => {
      if (entry.chapter === null || entry.mission === null) return invalid(field, "format");
      return { chapter: entry.chapter, mission: entry.mission };
    });
  } else if (field.codec === "counts") {
    if (
      typeof value !== "string" ||
      !isSweepCountStringValid(value, field.constraints?.length || 0)
    )
      invalid(field, "format");
    input = value.split(",").map((token) => ({
      mode: token.trim() === "max" ? "all" : Number(token) <= 0 ? "skip" : "count",
      amount: token.trim() === "max" ? 1 : Number(token),
    }));
  } else if (field.codec === "activity-counts") {
    const parsed = readActivitySweepCounts(value);
    if (!parsed || parsed.some((count) => !count.valid)) invalid(field, "format");
    input = parsed.map((count) => ({ mode: count.mode, amount: count.amount }));
  } else if (field.codec === "string-list" && typeof value === "string") {
    // Old crafting profiles used '>' while desktop writes the modern array form.
    if (!field.key.startsWith("createPriority_phase")) invalid(field, "type");
    input = value
      .split(">")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return parseConfigurationValue(field, input);
}

export function formatConfigurationValue(field: ConfigField, value: unknown = field.value): string {
  if (field.sensitive && value !== "") return REDACTED;
  if (field.type === "switch")
    return configurationText(
      (field.codec === "numeric-switch" ? value === 1 : value === true)
        ? "plugins.enabled"
        : "plugins.disabled",
      field.language
    );
  const optionLabel = (value: unknown) =>
    field.options?.find((option) => Object.is(option.value, value))?.label ?? String(value ?? "");
  if (field.type === "select") return optionLabel(value);
  if (field.type === "multiselect" || field.type === "list") {
    const values =
      field.codec === "csv-selection" && typeof value === "string"
        ? value.split(",").filter(Boolean)
        : Array.isArray(value)
          ? value
          : field.codec === "string-list" && typeof value === "string"
            ? value.split(">")
            : [];
    return values.map(optionLabel).join(" → ") || "—";
  }
  if (field.type === "rows")
    return `${Array.isArray(field.editorValue) ? field.editorValue.length : 0} · ${field.label}`;
  return String(value ?? "");
}
