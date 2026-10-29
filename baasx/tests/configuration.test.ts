import { describe, expect, test } from "bun:test";
import {
  configurationFields,
  configurationSections,
  configurationText,
  formatConfigurationValue,
  getConfigurationField,
  parseConfigurationValue,
  validateConfigurationChange,
  validateConfigurationStoredValue,
  ConfigurationValueError,
  type ConfigField,
} from "../src/configuration";

const snapshot = () => ({
  server: "官服",
  name: "Private profile",
  adbIP: "127.0.0.1",
  adbPort: "5555",
  screenshot_interval: "0.3",
  autostart: false,
  then: "无动作",
  screenshot_method: "adb",
  control_method: "scrcpy",
  cafe_reward_collect_hour_reward: false,
  cafe_reward_use_invitation_ticket: true,
  cafe_reward_allow_exchange_student: true,
  cafe_reward_allow_duplicate_invite: false,
  cafe_reward_has_no2_cafe: true,
  cafe_reward_affection_pat_round: 5,
  patStyle: "拖动礼物",
  cafe_reward_interaction_shot_delay: 1.25,
  cafe_reward_invite1_criterion: "starred",
  cafe_reward_invite1_starred_student_position: 2,
  favorStudent1: [],
  cafe_reward_invite2_criterion: "name",
  cafe_reward_invite2_starred_student_position: 1,
  favorStudent2: ["爱丽丝"],
  lesson_enableInviteFavorStudent: true,
  lesson_favorStudent: ["爱丽丝"],
  lesson_relationship_first: false,
  lesson_each_region_object_priority: [["primary", "advanced"], ["normal"]],
  lesson_times: [1, 2],
  CommonShopList: [1, 0],
  CommonShopRefreshTime: 0,
  TacticalChallengeShopList: [0, 1],
  TacticalChallengeShopRefreshTime: 1,
  use_acceleration_ticket: true,
  createTime: "3",
  create_phase: 3,
  create_phase_1_select_item_rule: "default",
  create_phase_2_select_item_rule: "primary_normal",
  create_phase_3_select_item_rule: "advanced_superior",
  createPriority_phase1: ["花", "金属"],
  createPriority_phase2: ["花"],
  createPriority_phase3: ["钻石"],
  ArenaLevelDiff: -1,
  ArenaComponentNumber: 2,
  maxArenaRefreshTimes: 10,
  ArenaStopFightWhenRank1: false,
  totalForceFightDifficulty: "INSANE",
  final_restriction_rls_employ_formation_method: "copy_clear_unit",
  final_restriction_rls_employ_formation_copy_clear_unit_max_unavailable_student_count: 2,
  final_restriction_rls_employ_formation_copy_clear_unit_max_refresh_count: 10,
  drill_enable_sweep: true,
  drill_fight_formation_list: [1, 2, 3],
  drill_difficulty_list: [4, 4, 4],
  clear_friend_white_list: ["abc1234"],
  clear_friend_level_limit: -1,
  clear_friend_last_login_time_days: -1,
  clear_friend_last_total_assault_rank_limit: -1,
  open_emulator_stat: false,
  emulator_wait_time: "180",
  emulatorIsMultiInstance: true,
  program_address: "C:\\emulator.exe",
  emulatorMultiInstanceNumber: 0,
  multiEmulatorName: "mumu",
  manual_boss: false,
  explore_task_use_simple_mode: true,
  explore_normal_task_list: "4,6-A",
  explore_hard_task_list: "1-2",
  main_story_regions: "1,3",
  choose_team_method: "preset",
  preset_team_attribute: [
    ["burst", "pierce"],
    ["mystic", "Unused"],
  ],
  side_team_attribute: [["shock"]],
  push_after_error: true,
  push_after_completion: false,
  push_json: "secret-push",
  push_serverchan: "",
  push_feishu: "secret-feishu",
  push_wecom: "",
  push_telegram_bot_token: "secret-token",
  push_telegram_chat_id: "123",
  push_telegram_proxy: "",
  push_telegram_api: "https://api.telegram.org",
  mainlinePriority: "1-1-3, 2-5-max",
  hardPriority: "1-1-3",
  rewarded_task_times: "max,0,2",
  scrimmage_times: "0,1,2",
  special_task_times: "max,0",
  activity_sweep_task_number: 2,
  activity_sweep_times: "0.5,2",
  purchase_rewarded_task_ticket_times: "max",
  purchase_lesson_ticket_times: "2",
  purchase_scrimmage_ticket_times: "0",
  ap: { count: 999 },
  create_item_holding_quantity: { secret_internal: 1 },
  last_refresh_config_time: "private",
  assetsVisibility: true,
  arbitrary: { injected: "must not appear" },
  hotkey_run: "Ctrl+1",
  unfinished_normal_tasks: ["1-1"],
});
const staticData = {
  screenshot_methods: ["adb", "scrcpy", "mss", "pyautogui"],
  control_methods: ["adb", "scrcpy", "pyautogui"],
  student_names: [
    { CN_name: "爱丽丝", JP_name: "アリス", Global_name: "Aris" },
    { CN_name: "优香", JP_name: "ユウカ", Global_name: "Yuuka" },
  ],
  lesson_region_name: { CN: ["校区一", "校区二"], JP: ["エリア一", "エリア二"] },
  common_shop_price_list: {
    CN: [
      ["铜笔记", 1000, "creditpoints"],
      ["技能书", 10, "pyroxene"],
    ],
  },
  tactical_challenge_shop_price_list: {
    CN: [
      ["饮料", 20],
      ["碎片", 100],
    ],
  },
  create_default_priority: {
    CN: { phase1: ["花", "金属"], phase2: ["花", "金属"], phase3: ["钻石"] },
  },
  total_assault_difficulties: { CN: ["NORMAL", "HARD", "INSANE", "TORMENT"] },
  main_story_available_episodes: { CN: [1, 2, 3] },
  explore_normal_task_region_range: [4, 30],
  explore_hard_task_region_range: [1, 30],
};
const options = { language: "en", staticData, platform: "win32" };
function field(path: string, config: Record<string, any> = snapshot()): ConfigField {
  const value = getConfigurationField(config, path, options);
  expect(value).toBeDefined();
  return value!;
}

describe("desktop configuration contract", () => {
  test("only exposes the desktop allowlist, never internal nested JSON", () => {
    const config = snapshot(),
      fields = configurationFields(config, options);
    expect(fields.length).toBeGreaterThan(90);
    for (const key of [
      "name",
      "ap",
      "arbitrary",
      "create_item_holding_quantity",
      "last_refresh_config_time",
      "assetsVisibility",
      "hotkey_run",
      "unfinished_normal_tasks",
    ]) {
      expect(fields.some((field) => field.key === key)).toBe(false);
      expect(() => validateConfigurationChange(config, `/${key}`, "changed", options)).toThrow(
        ConfigurationValueError
      );
    }
    expect(getConfigurationField(config, "/__proto__/polluted", options)).toBeUndefined();
    expect(configurationSections(config, options).map((section) => section.id)).toContain("cafe");
    expect(
      configurationSections(config, options).every((section) => section.fields.length > 0)
    ).toBe(true);
    expect(
      fields.every(
        (field) => field.label !== field.labelKey && field.sectionLabel !== field.section
      )
    ).toBe(true);
    expect(() => structuredClone(fields)).not.toThrow();
    expect(config).toEqual(snapshot());
  });

  test("uses desktop translations in all seven locales while preserving wire values", () => {
    for (const language of ["zh", "en", "ja", "ko", "de", "fr", "ru"]) {
      const fields = configurationFields(snapshot(), { ...options, language });
      const then = fields.find((field) => field.path === "/then")!;
      expect(then.label).toBe(configurationText("script.then", language));
      expect(then.options![0].value).toBe("无动作");
      expect(then.options![0].label).toBe(configurationText("script.doNothing", language));
      expect(then.options![0].label).not.toBe("无动作");
      expect(configurationText("artifact.phase2", language)).not.toBe("artifact.phase2");
    }
    expect(formatConfigurationValue(field("/then"))).toBe("Do nothing");
    expect(formatConfigurationValue(field("/server"))).toBe("Official (CN)");
    expect(parseConfigurationValue(field("/then"), "关机")).toBe("关机");
    expect(() => parseConfigurationValue(field("/then"), "Shutdown Computer")).toThrow();
  });

  test("server is immutable and PC profiles hide ADB and restrict capture controls", () => {
    expect(field("/server").readOnly).toBe(true);
    expect(() => parseConfigurationValue(field("/server"), "日服")).toThrow();
    const pc = {
      ...snapshot(),
      server: "日服PC端",
      screenshot_method: "mss",
      control_method: "pyautogui",
    };
    const fields = configurationFields(pc, options);
    expect(fields.some((field) => field.key === "adbIP" || field.key === "adbPort")).toBe(false);
    expect(field("/screenshot_method", pc).options!.map((option) => option.value)).toEqual([
      "mss",
      "pyautogui",
    ]);
    expect(
      getConfigurationField(pc, "/screenshot_method", { ...options, platform: "linux" })!.readOnly
    ).toBe(true);
    for (const platform of ["android", "webui"])
      expect(
        configurationFields(snapshot(), { ...options, platform }).some(
          (item) => item.section === "emulator"
        )
      ).toBe(false);
  });

  test("enforces cafe, crafting, final restriction, emulator and team conditions", () => {
    const config = snapshot();
    expect(getConfigurationField(config, "/favorStudent1", options)).toBeUndefined();
    expect(
      getConfigurationField(config, "/cafe_reward_invite2_starred_student_position", options)
    ).toBeUndefined();
    config.cafe_reward_has_no2_cafe = false;
    expect(getConfigurationField(config, "/favorStudent2", options)).toBeUndefined();
    config.patStyle = "普通";
    expect(
      getConfigurationField(config, "/cafe_reward_interaction_shot_delay", options)
    ).toBeUndefined();
    config.create_phase = 1;
    expect(getConfigurationField(config, "/createPriority_phase2", options)).toBeUndefined();
    config.emulatorIsMultiInstance = false;
    expect(getConfigurationField(config, "/emulatorMultiInstanceNumber", options)).toBeUndefined();
    config.final_restriction_rls_employ_formation_method = "default";
    expect(
      field("/final_restriction_rls_employ_formation_copy_clear_unit_max_refresh_count", config)
        .readOnly
    ).toBe(true);
    expect(getConfigurationField(config, "/side_team_attribute/0/0", options)).toBeUndefined();
    config.choose_team_method = "side";
    expect(field("/side_team_attribute/0/0", config).type).toBe("select");
    expect(getConfigurationField(config, "/preset_team_attribute/0/0", options)).toBeUndefined();
  });

  test("absent newer backend keys never become writable defaults", () => {
    const config: Record<string, any> = snapshot();
    for (const key of [
      "push_wecom",
      "ArenaStopFightWhenRank1",
      "main_story_regions",
      "explore_task_use_simple_mode",
      "cafe_reward_interaction_shot_delay",
    ])
      delete config[key];
    expect(
      configurationFields(config, options).some((field) =>
        [
          "push_wecom",
          "ArenaStopFightWhenRank1",
          "main_story_regions",
          "explore_task_use_simple_mode",
          "cafe_reward_interaction_shot_delay",
        ].includes(field.key)
      )
    ).toBe(false);
  });

  test("numbers enforce bounds and preserve desktop string/number storage", () => {
    expect(parseConfigurationValue(field("/screenshot_interval"), "0.125")).toBe("0.125");
    expect(parseConfigurationValue(field("/createTime"), 4)).toBe("4");
    expect(parseConfigurationValue(field("/ArenaLevelDiff"), "-89")).toBe(-89);
    expect(parseConfigurationValue(field("/cafe_reward_interaction_shot_delay"), 0.01)).toBe(0.01);
    for (const [path, input] of [
      ["/ArenaLevelDiff", 90],
      ["/maxArenaRefreshTimes", 1.5],
      ["/createTime", 0],
      ["/CommonShopRefreshTime", 6],
      ["/screenshot_interval", 0.01],
      ["/cafe_reward_interaction_shot_delay", -1],
      ["/emulatorMultiInstanceNumber", -1],
      ["/clear_friend_level_limit", -2],
      ["/lesson_times/0", 100],
      ["/maxArenaRefreshTimes", ""],
      ["/maxArenaRefreshTimes", Infinity],
      ["/maxArenaRefreshTimes", true],
    ] as const)
      expect(() => parseConfigurationValue(field(path), input)).toThrow();
    expect(parseConfigurationValue(field("/ArenaComponentNumber"), "3")).toBe(3);
    expect(() => parseConfigurationValue(field("/ArenaComponentNumber"), 4)).toThrow();
  });

  test("ADB supports host/port and a lone USB serial without allowing an empty endpoint", () => {
    expect(parseConfigurationValue(field("/adbPort"), "65535")).toBe("65535");
    expect(() => parseConfigurationValue(field("/adbPort"), 65536)).toThrow();
    expect(parseConfigurationValue(field("/adbPort"), "")).toBe("");
    const config = { ...snapshot(), adbIP: "", adbPort: "USB-SERIAL" };
    expect(field("/adbPort", config).type).toBe("text");
    expect(parseConfigurationValue(field("/adbPort", config), "USB-SERIAL")).toBe("USB-SERIAL");
    expect(() => parseConfigurationValue(field("/adbPort", config), "")).toThrow();
    expect(() => parseConfigurationValue(field("/adbIP", config), "127.0.0.1")).toThrow();
    expect(
      parseConfigurationValue(field("/adbIP", { ...config, adbPort: "5555" }), "127.0.0.1")
    ).toBe("127.0.0.1");
  });

  test("checkboxes and numeric shop masks cannot be confused with text or booleans", () => {
    expect(parseConfigurationValue(field("/autostart"), true)).toBe(true);
    expect(() => parseConfigurationValue(field("/autostart"), "false")).toThrow();
    const shop = field("/CommonShopList/0");
    expect(shop.editorValue).toBe(true);
    expect(parseConfigurationValue(shop, false)).toBe(0);
    expect(validateConfigurationStoredValue(snapshot(), shop.path, 1, options)).toBe(1);
    expect(() => validateConfigurationStoredValue(snapshot(), shop.path, true, options)).toThrow();
  });

  test("student and priority labels come from server catalog names, with imported values retained safely", () => {
    const names = field("/favorStudent2");
    expect(names.options!.map((option) => option.value)).toEqual(["爱丽丝", "优香"]);
    expect(parseConfigurationValue(names, ["优香", "爱丽丝"])).toEqual(["优香", "爱丽丝"]);
    expect(() => parseConfigurationValue(names, ["not-a-student"])).toThrow();
    const config = { ...snapshot(), favorStudent2: ["legacy-name"] };
    const imported = field("/favorStudent2", config);
    expect(imported.options!.find((option) => option.value === "legacy-name")!.disabled).toBe(true);
    expect(parseConfigurationValue(imported, ["legacy-name"])).toEqual(["legacy-name"]);
    expect(parseConfigurationValue(imported, [])).toEqual([]);
    const jp = { ...snapshot(), server: "日服", favorStudent2: ["アリス"] };
    expect(field("/favorStudent2", jp).options!.map((option) => option.value)).toEqual([
      "アリス",
      "ユウカ",
    ]);
    expect(parseConfigurationValue(field("/createPriority_phase1"), ["金属", "花"])).toEqual([
      "金属",
      "花",
    ]);
  });

  test("friend codes follow desktop CN, global and JP rules and threshold sentinel", () => {
    expect(parseConfigurationValue(field("/clear_friend_white_list"), ["abc1234"])).toEqual([
      "abc1234",
    ]);
    for (const input of [["ABC1234"], ["abc"], ["abc1234", "abc1234"]])
      expect(() => parseConfigurationValue(field("/clear_friend_white_list"), input)).toThrow();
    const global = { ...snapshot(), server: "国际服" };
    expect(
      parseConfigurationValue(field("/clear_friend_white_list", global), ["ABCDEFGH"])
    ).toEqual(["ABCDEFGH"]);
    expect(() =>
      parseConfigurationValue(field("/clear_friend_white_list", global), ["Abcdefgh"])
    ).toThrow();
    expect(parseConfigurationValue(field("/clear_friend_level_limit"), -1)).toBe(-1);
  });

  test("sweep plans use typed rows and the shared server-specific maximum rule", () => {
    const normal = field("/mainlinePriority");
    expect(normal.type).toBe("rows");
    expect(normal.editorValue).toEqual([
      { chapter: 1, mission: 1, count: 3, maximum: false },
      { chapter: 2, mission: 5, count: 3, maximum: true },
    ]);
    expect(parseConfigurationValue(normal, normal.editorValue)).toBe("1-1-3, 2-5-max");
    expect(parseConfigurationValue(normal, [])).toBe("");
    expect(() =>
      parseConfigurationValue(field("/hardPriority"), [
        { chapter: 1, mission: 1, count: 3, maximum: true },
      ])
    ).toThrow();
    const jp = { ...snapshot(), server: "日服" };
    expect(
      parseConfigurationValue(field("/hardPriority", jp), [
        { chapter: 1, mission: 1, count: 3, maximum: true },
      ])
    ).toBe("1-1-max");
    expect(() =>
      parseConfigurationValue(normal, [{ chapter: 31, mission: 1, count: 3, maximum: false }])
    ).toThrow();
    expect(() =>
      parseConfigurationValue(normal, [{ chapter: 1, mission: 6, count: 3, maximum: false }])
    ).toThrow();
    expect(() => parseConfigurationValue(normal, "1-1-3")).toThrow();
    expect(() =>
      parseConfigurationValue(normal, [{ chapter: 1, mission: 1, count: 3, maximum: "false" }])
    ).toThrow();
    expect(validateConfigurationStoredValue(snapshot(), normal.path, "1-1-3", options)).toBe(
      "1-1-3"
    );
  });

  test("exploration rows enforce mission A and hard stage limits", () => {
    const normal = field("/explore_normal_task_list");
    expect(
      parseConfigurationValue(normal, [
        { chapter: 6, mission: "A" },
        { chapter: 5, mission: "all" },
      ])
    ).toBe("6-A,5");
    expect(() => parseConfigurationValue(normal, [{ chapter: 5, mission: "A" }])).toThrow();
    expect(() =>
      parseConfigurationValue(field("/explore_hard_task_list"), [{ chapter: 1, mission: "4" }])
    ).toThrow();
    expect(normal.defaultRow).toEqual({ chapter: 4, mission: "all" });
    expect(() => parseConfigurationValue(normal, [{ chapter: 3, mission: "all" }])).toThrow();
    const capped = getConfigurationField(snapshot(), normal.path, {
      ...options,
      staticData: { ...staticData, max_region: { CN: 20 } },
    })!;
    expect(capped.columns![0].max).toBe(20);
    expect(() => parseConfigurationValue(capped, [{ chapter: 21, mission: "all" }])).toThrow();
  });

  test("activity stage controls use numeric server catalog values and retain the saved stage", () => {
    const active = getConfigurationField(snapshot(), "/activity_sweep_task_number", {
      ...options,
      staticData: {
        ...staticData,
        current_game_activity: { CN: { mission: { "任务 1": [], mission3: [], unrelated: [] } } },
      },
    })!;
    expect(active.type).toBe("select");
    expect(active.options!.map((option) => option.value)).toEqual([1, 3, 2]);
    expect(parseConfigurationValue(active, "3")).toBe(3);
    expect(parseConfigurationValue(active, 2)).toBe(2);
    expect(() => parseConfigurationValue(active, 4)).toThrow();
    expect(field("/activity_sweep_task_number").type).toBe("number");
  });

  test("sweep count modes serialize fixed, all and AP share semantics without raw JSON", () => {
    const counts = field("/scrimmage_times");
    expect(
      parseConfigurationValue(counts, [
        { mode: "skip", amount: 1 },
        { mode: "all", amount: 1 },
        { mode: "count", amount: 7 },
      ])
    ).toBe("0,max,7");
    expect(() => parseConfigurationValue(counts, [{ mode: "all", amount: 1 }])).toThrow();
    const activity = field("/activity_sweep_times");
    expect(parseConfigurationValue(activity, [{ mode: "share", amount: 100 }])).toBe("1.0");
    expect(parseConfigurationValue(activity, [{ mode: "count", amount: 1 }])).toBe("1");
    expect(parseConfigurationValue(activity, [{ mode: "all", amount: 0 }])).toBe("-1");
    expect(() => parseConfigurationValue(activity, [{ mode: "share", amount: 101 }])).toThrow();
    expect(() =>
      parseConfigurationValue(activity, [
        { mode: "all", amount: 0 },
        { mode: "count", amount: 1 },
      ])
    ).toThrow();
    expect(
      field("/rewarded_task_times", { ...snapshot(), server: "日服" }).constraints!.length
    ).toBe(5);
  });

  test("main story selection uses the backend episode catalog and writes its CSV wire value", () => {
    const episodes = field("/main_story_regions");
    expect(episodes.editorValue).toEqual(["1", "3"]);
    expect(parseConfigurationValue(episodes, ["3", "1"])).toBe("3,1");
    expect(parseConfigurationValue(episodes, [])).toBe("");
    expect(() => parseConfigurationValue(episodes, ["9"])).toThrow();
    expect(() => parseConfigurationValue(episodes, ["1", "1"])).toThrow();
    const absent = getConfigurationField(snapshot(), "/main_story_regions", { language: "en" })!;
    expect(() => parseConfigurationValue(absent, ["1"])).toThrow();
  });

  test("secrets stay masked in display and redacted placeholders cannot be written", () => {
    const secret = field("/push_telegram_bot_token");
    expect(secret.sensitive).toBe(true);
    expect(formatConfigurationValue(secret)).toBe("[REDACTED]");
    expect(formatConfigurationValue(secret)).not.toContain("secret-token");
    expect(() => parseConfigurationValue(secret, "[REDACTED]")).toThrow();
    expect(parseConfigurationValue(secret, "")).toBe("");
    expect(parseConfigurationValue(secret, "new-secret")).toBe("new-secret");
  });
});
