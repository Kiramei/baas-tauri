// Development-only integration surface. Real App.Main/routes/providers; no backend or device.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "../../src/components/ui/Sonner";
import { Main as DesktopMain } from "../../src/App";
import { Main as AndroidMain, useAndroidViewport } from "../../src/android/App";
import { AppProvider } from "../../src/context/AppContext";
import { AboutBaasProvider } from "../../src/context/AboutBaasProvider";
import { ProfileActionsProvider } from "../../src/context/ProfileActionsProvider";
import { ThemeProvider, useTheme } from "../../src/context/ThemeProvider";
import { UISettingsProvider, useUISettings } from "../../src/context/UISettingsProvider";
import { WindowLayoutProvider } from "../../src/context/WindowLayoutProvider";
import { NavigationHistoryProvider } from "../../src/context/NavigationHistoryProvider";
import { TauriSelfUpdateProvider } from "../../src/context/TauriSelfUpdateProvider";
import { TauriShortcutProvider } from "../../src/context/TauriShortcutProvider";
import GlobalAppearanceEffects from "../../src/components/GlobalAppearanceEffects";
import TitlebarMenus from "../../src/components/layout/TitlebarMenus";
import LanguageSelect from "../../src/components/LanguageSelect";
import i18n, { initI18n, loadLocale } from "../../src/shared/I18nTranslator";
import { SERVER_VALUES } from "../../src/shared/serverOptions";
import { recordFrontendSystemLog } from "../../src/shared/SystemLogService";
import { useWebSocketStore } from "../../src/store/WebsocketStore";
import type { EventConfig } from "../../src/types/event";
import type { PageKey } from "../../src/types/app";
import "../../src/styles/index.css";

if (!import.meta.env.DEV || (!__WITH_WEBUI__ && !__WITH_ANDROID__) || __WITH_TAURI__)
  throw new Error("This isolated fixture requires a Vite development browser");

const AppMain = __WITH_ANDROID__ ? AndroidMain : DesktopMain;

const query = new URLSearchParams(location.search);
const schedulerPreview = query.get("scheduler") === "1";
const configurationPreview = query.get("configuration") === "1";
const logSamples = [
  ["DEBUG", "Matched main_page feature in 42 ms"],
  ["INFO", "咖啡厅任务开始，正在检查学生互动状态。"],
  ["INFO", "Tap student: 阿洛娜 · affection interaction complete"],
  ["WARNING", "Screenshot delayed; retrying with the next frame"],
  ["INFO", "Cafe rewards collected successfully"],
  [
    "ERROR",
    "Fixture sample: failed to load D:\\BAAS\\.venv\\Lib\\site-packages\\baas_native\\resources\\windows-x86_64\\release\\dependencies\\capture\\screenshot_transport_acceleration.dll (synthetic path; no real device was used)",
  ],
  ["DEBUG", "Reconnect transport completed in 128 ms\n  Hard newline preserved: transport ready"],
  ["INFO", "任务执行结束，等待下一次调度。"],
];
// Synthetic examples of script syntax; never load a user's execution log into the fixture.
const highlightSamples = [
  ["INFO", "-------------- Init Device --------------"],
  ["INFO", "Serial : 127.0.0.1:5555"],
  ["INFO", String.raw`nemu_folder = C:\Program Files\Emulator`],
  ["INFO", String.raw`ipc_dll = C:\Program Files\Emulator\bin\capture_client.dll`],
  ["INFO", "Screen Size (1280, 720)"],
  ["INFO", "Scheduler : {\n  pre_task : []\n  current_task : arena\n  post_task : []\n}"],
  ["INFO", "current_task: [ arena ] start"],
  ["INFO", "Image feature: main_page_quick-home -> Click @ (1236,31)"],
  ["INFO", "Ocr Arena Ticket Number : 1/5 | Time : 3ms"],
  ["INFO", "Control method : nemu"],
  ["WARNING", "Screenshot delayed; retrying in 0.3s"],
  ["INFO", "REWARD STATUS: [True, False]"],
  ["INFO", "arena next_time : 2026-01-02 04:00:00"],
  ["INFO", "Open resource: https://example.invalid/assets/main_page.json"],
  ["INFO", "Check Package [ com.example.BlueArchive ] Exist."],
  ["INFO", "-------- Initialization Finished --------"],
];
const homeLogSamples = query.get("highlight") === "1" ? highlightSamples : logSamples;

// Locale/font/image loads may reach this Vite origin. API requests cannot leave it.
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input : input.url,
    location.href
  );
  if (query.get("logs") === "1" && url.pathname === "/system/logs") {
    return Promise.resolve(
      Response.json({
        entries: Array.from({ length: 96 }, (_, index) => ({
          timestamp: new Date(Date.now() - (96 - index) * 1000).toISOString(),
          level: logSamples[index % logSamples.length][0],
          logger: index % 3 === 0 ? "service.scheduler" : "tasks.cafe_reward",
          message: logSamples[index % logSamples.length][1],
          module: "cafe_reward.py",
          line: 120 + index,
          ...(index % 8 === 5
            ? {
                exception:
                  "ConnectionError: isolated fixture sample\n  at capture_frame (device.py:128)",
              }
            : {}),
        })),
        files: [{ path: "fixture/logs/service.log", size: 24000 }],
      })
    );
  }
  if (url.origin !== location.origin || /^\/(?:android|system|api)(?:\/|$)/.test(url.pathname))
    return Promise.reject(new Error(`Fixture blocked API request: ${url.origin}${url.pathname}`));
  return nativeFetch(input, init);
};
localStorage.setItem(
  "uiSettings",
  JSON.stringify({
    lang: query.get("lang") || "zh",
    theme: query.get("theme") || "light",
    idleAutoUpdate: false,
    lowPerformanceMode: false,
    settingsSection: query.get("section") || "appearance",
  })
);
localStorage.setItem("theme", query.get("theme") || "light");
localStorage.removeItem("idleBackendUpdateResume");
localStorage.removeItem("idleBackendUpdateAttempt");
await initI18n();
if (query.get("logs") === "1") {
  for (const [index, [level, message]] of logSamples.entries()) {
    recordFrontendSystemLog(
      level as "DEBUG" | "INFO" | "WARNING" | "ERROR",
      index % 2 ? "transport" : "scheduler",
      message,
      index === 5 ? { fixture: true, retryAfterMs: 1000 } : undefined
    );
  }
}

const stamp = Math.floor(Date.now() / 1000);
const reading = (count: number) => ({ count, time: stamp });
// Opt-in, entirely synthetic profile data for mounting every real configuration panel.
// Each call owns its arrays so saving one profile can never mutate the other profile's seed.
const configurationProfile = (secondary: boolean) => ({
  cafe_reward_collect_hour_reward: !secondary,
  cafe_reward_use_invitation_ticket: true,
  cafe_reward_allow_exchange_student: secondary,
  cafe_reward_allow_duplicate_invite: false,
  cafe_reward_has_no2_cafe: !secondary,
  cafe_reward_affection_pat_round: secondary ? 8 : 5,
  cafe_reward_invite1_criterion: "lowest_affection",
  cafe_reward_invite2_criterion: "lowest_affection",
  cafe_reward_invite1_starred_student_position: 1,
  cafe_reward_invite2_starred_student_position: 2,
  favorStudent1: [secondary ? "Example Student B" : "示例学生 A"],
  favorStudent2: [],
  patStyle: "普通",
  lesson_enableInviteFavorStudent: !secondary,
  lesson_favorStudent: [],
  lesson_relationship_first: secondary,
  lesson_each_region_object_priority: Array.from({ length: 4 }, () => [
    "primary",
    "normal",
    "advanced",
    "superior",
  ]),
  lesson_times: secondary ? [2, 1, 0, 1] : [1, 1, 1, 1],
  CommonShopList: secondary ? [0, 1, 0, 1] : [1, 0, 1, 0],
  CommonShopRefreshTime: secondary ? "1" : "0",
  TacticalChallengeShopList: secondary ? [0, 1, 1, 0] : [1, 1, 0, 0],
  TacticalChallengeShopRefreshTime: "0",
  use_acceleration_ticket: !secondary,
  createTime: secondary ? "2" : "1",
  create_phase: 3,
  create_phase_1_select_item_rule: "default",
  create_phase_2_select_item_rule: "primary_normal",
  create_phase_3_select_item_rule: "advanced_superior",
  createPriority_phase1: ["Special", "Material", "Furniture"],
  createPriority_phase2: ["Gift", "Material", "Furniture"],
  createPriority_phase3: ["Gift", "Material"],
  ArenaLevelDiff: secondary ? 10 : 5,
  ArenaComponentNumber: secondary ? 2 : 1,
  maxArenaRefreshTimes: secondary ? 5 : 3,
  mainlinePriority: secondary ? "12-1-1, 12-2-1" : "10-1-1, 10-2-1",
  hardPriority: secondary ? "12-1-3" : "10-1-3",
  rewarded_task_times: "1,1,0",
  scrimmage_times: "0,0,0",
  special_task_times: "0,0",
  activity_sweep_task_number: 1,
  activity_sweep_times: "0",
  purchase_rewarded_task_ticket_times: "0",
  purchase_lesson_ticket_times: "0",
  purchase_scrimmage_ticket_times: "0",
  totalForceFightDifficulty: secondary ? "HARD" : "NORMAL",
  final_restriction_rls_employ_formation_method: secondary ? "copy_clear_unit" : "default",
  final_restriction_rls_employ_formation_copy_clear_unit_max_unavailable_student_count: 1,
  final_restriction_rls_employ_formation_copy_clear_unit_max_refresh_count: 3,
  drill_enable_sweep: !secondary,
  drill_fight_formation_list: secondary ? [3, 2, 1] : [1, 2, 3],
  drill_difficulty_list: secondary ? [3, 3, 3] : [2, 2, 2],
  clear_friend_white_list: [],
  clear_friend_level_limit: secondary ? 30 : 20,
  clear_friend_last_login_time_days: secondary ? 14 : 7,
  clear_friend_last_total_assault_rank_limit: -1,
  adbIP: "127.0.0.1",
  adbPort: secondary ? "5557" : "5555",
  screenshot_interval: secondary ? "0.8" : "0.3",
  autostart: false,
  then: "无动作",
  screenshot_method: "adb",
  control_method: "uiautomator2",
  open_emulator_stat: false,
  emulator_wait_time: secondary ? "10" : "5",
  emulatorIsMultiInstance: secondary,
  program_address: String.raw`D:\Fixture\Emulator\emulator.exe`,
  emulatorMultiInstanceNumber: secondary ? 1 : 0,
  multiEmulatorName: secondary ? "mumu_global" : "mumu",
  manual_boss: secondary,
  explore_normal_task_list: secondary ? "12-1" : "10-1",
  explore_hard_task_list: secondary ? "12-1" : "10-1",
  choose_team_method: secondary ? "side" : "preset",
  side_team_attribute: [["burst"], ["pierce"], ["mystic"], ["Unused"]],
  preset_team_attribute: [
    ["burst", "pierce", "mystic", "Unused"],
    ["mystic", "burst", "Unused", "Unused"],
  ],
  push_after_error: false,
  push_after_completion: false,
  push_json: "",
  push_serverchan: "",
  new_event_enable_state: "default",
});

const configurationStatic = {
  student_names: ["A", "B", "C"].map((letter) => ({
    CN_name: `示例学生 ${letter}`,
    Global_name: `Example Student ${letter}`,
    JP_name: `サンプル生徒 ${letter}`,
    CN_implementation: true,
    Global_implementation: true,
    JP_implementation: true,
  })),
  lesson_region_name: {
    CN: ["示例校区 A", "示例校区 B", "示例校区 C", "示例校区 D"],
    "Global_en-us": [
      "Example Campus A",
      "Example Campus B",
      "Example Campus C",
      "Example Campus D",
    ],
    "Global_zh-tw": ["範例校區 A", "範例校區 B", "範例校區 C", "範例校區 D"],
    "Global_ko-kr": [
      "Example Campus A",
      "Example Campus B",
      "Example Campus C",
      "Example Campus D",
    ],
    JP: ["サンプル校区 A", "サンプル校区 B", "サンプル校区 C", "サンプル校区 D"],
  },
  common_shop_price_list: Object.fromEntries(
    ["CN", "Global", "JP"].map((server) => [
      server,
      [
        ["示例商品 A", 1000, "creditpoints"],
        ["示例商品 B", 2000, "creditpoints"],
        ["示例商品 C", 25, "pyroxene"],
        ["示例商品 D", 10, "bounty_coin"],
      ],
    ])
  ),
  tactical_challenge_shop_price_list: Object.fromEntries(
    ["CN", "Global", "JP"].map((server) => [
      server,
      [
        ["示例竞技商品 A", 5],
        ["示例竞技商品 B", 10],
        ["示例竞技商品 C", 15],
        ["示例竞技商品 D", 20],
      ],
    ])
  ),
  create_default_priority: Object.fromEntries(
    ["CN", "Global", "Global_zh-tw", "Global_ko-kr", "JP"].map((server) => [
      server,
      {
        phase1: ["Special", "Material", "Furniture"],
        phase2: ["Gift", "Material", "Furniture"],
        phase3: ["Gift", "Material"],
      },
    ])
  ),
  create_phase2_recommended_priority: {
    "示例学生 A": [0, 1],
    "Example Student B": [1, 0],
  },
  hard_task_student_material: [
    ["10-1", "示例学生 A"],
    ["12-1", "示例学生 B"],
    ["14-1", "示例学生 A"],
  ],
  explore_normal_task_region_range: [4, 30],
  explore_hard_task_region_range: [1, 30],
  total_assault_difficulties: Object.fromEntries(
    ["CN", "Global", "JP"].map((server) => [server, ["NORMAL", "HARD", "VERYHARD", "HARDCORE"]])
  ),
  current_game_activity: Object.fromEntries(
    ["CN", "Global", "JP"].map((server) => [
      server,
      query.get("activity") === "1"
        ? {
            activity_name: "Preview event",
            story: { "Story 1": "burst", "Story 2": "pierce" },
            mission: Object.fromEntries(
              Array.from({ length: 12 }, (_, index) => [
                `Mission ${index + 1}`,
                ["burst", "pierce", "mystic", "shock"][index % 4],
              ])
            ),
            challenge: { "Challenge 1": "mystic", "Challenge 2": "shock" },
          }
        : null,
    ])
  ),
  screenshot_methods: ["adb", "nemu"],
  control_methods: ["uiautomator2", "nemu"],
};

const profiles = {
  alpha: {
    ...(configurationPreview ? configurationProfile(false) : {}),
    name: "Schale · 日常",
    cafe_reward_collect_hour_reward: true,
    cafe_reward_allow_exchange_student: false,
    server: SERVER_VALUES.CN_BILIBILI,
    ap: { ...reading(681), max: 240 },
    creditpoints: reading(299239710),
    pyroxene: reading(115942),
    tactical_challenge_coin: reading(33690),
    bounty_coin: reading(32),
    create_item_holding_quantity: { Keystone: 17, "Keystone-Piece": 6 },
    _pass: { level: 42, max_level: 60, time: stamp },
  },
  beta: {
    ...(configurationPreview ? configurationProfile(true) : {}),
    name: "Global · Preview",
    server: SERVER_VALUES.GLOBAL,
    ap: { ...reading(120), max: 240 },
    creditpoints: reading(2680912),
    pyroxene: reading(12000),
    _pass: { level: 8, max_level: 60, time: stamp },
  },
};
const task = (name: string, extra: Partial<EventConfig> = {}): EventConfig => ({
  func_name: name,
  event_name: name,
  priority: 1,
  enabled: true,
  interval: 86400,
  next_tick: stamp + 3600,
  pre_task: [],
  post_task: [],
  daily_reset: [],
  disabled_time_range: [],
  ...extra,
});
// Interleaved enabled states exercise the production grouping under every sort mode.
// Real translated IDs include long names in both Chinese and English; no backend is contacted.
const schedulerTasks = [
  task("total_assault", { enabled: false, priority: 9, next_tick: stamp - 86400 }),
  task("cafe_reward", { priority: 3, next_tick: stamp + 1800 }),
  task("arena", { priority: 2, next_tick: stamp + 3600 }),
  task("activity_sweep", { enabled: false, priority: 1, next_tick: stamp + 120 }),
  task("no1_cafe_invite", { priority: 4, next_tick: stamp + 7200 }),
  task("no2_cafe_invite", { priority: 4, next_tick: stamp + 5400 }),
  task("friend", { enabled: false, priority: 8, next_tick: stamp - 3600 }),
  task("collect_daily_power", { priority: 5, next_tick: stamp + 900 }),
  task("collect_daily_free_power", { priority: 5, next_tick: stamp + 600 }),
  task("mail", { priority: 6, next_tick: stamp + 4800 }),
  task("lesson", { priority: 7, next_tick: stamp + 10800 }),
  task("start_explore_activity_challenge", {
    enabled: false,
    priority: 1,
    next_tick: stamp + 86400 * 7,
  }),
  task("create", { priority: 8, next_tick: stamp + 1200 }),
  task("collect_reward", { priority: 9, next_tick: stamp + 2400 }),
  task("tactical_challenge_shop", { priority: 10, next_tick: stamp + 3600 * 6 }),
  task("common_shop", { priority: 10, next_tick: stamp + 3600 * 12 }),
  task("clear_special_task_power", { enabled: false, priority: 2, next_tick: stamp + 300 }),
  task("normal_task", { priority: 11, next_tick: stamp + 3600 * 4 }),
  task("hard_task", { priority: 11, next_tick: stamp + 3600 * 3 }),
  task("start_explore_activity_mission", {
    enabled: false,
    priority: 3,
    next_tick: stamp + 86400 * 3,
  }),
];
const fixtureTasks = schedulerPreview
  ? schedulerTasks
  : ["cafe_reward", "collect_daily_power", "create", "collect_reward"].map((name) => task(name));
const commands: string[] = [];
const blocked = async () => {
  throw new Error("Fixture has no backend connection");
};
const trigger: ReturnType<typeof useWebSocketStore.getState>["trigger"] = (payload, callback) => {
  commands.push(payload.command);
  if (payload.command === "test_all_sha_stream") {
    // Render the real streamed-result UI without contacting any update host.
    const methods = [
      "github",
      "mirrorc",
      "cnb",
      "gitee",
      "gitcode",
      "github_proxy_v4",
      "github_proxy_v6",
      "github_proxy_cdn",
      "gh_proxy",
      "sevencdn",
      "githubfast",
    ];
    for (const [index, name] of methods.entries()) {
      callback?.({
        type: "command_response",
        command: payload.command,
        status: "ok",
        data: {
          name,
          success: index !== 1,
          duration: index === 1 ? 0 : 0.8 + index * 0.137,
          value: index === 1 ? null : "a183e1c9b4e5848c3db56e50210b95c64adf13fb",
        },
      });
    }
    callback?.({
      type: "command_response",
      command: payload.command,
      status: "ok",
      data: { done: true },
    });
    return;
  }
  const pid = payload.config_id;
  if (pid && ["start_scheduler", "stop_scheduler"].includes(payload.command)) {
    useWebSocketStore.setState((state) => ({
      statusStore: {
        ...state.statusStore,
        [pid]: {
          ...state.statusStore[pid],
          running: payload.command === "start_scheduler",
        },
      },
    }));
  }
  callback?.({
    type: "command_response",
    command: payload.command,
    status: "ok",
    data: {
      success: true,
      local: "fixture-local",
      remote: "fixture-local",
      message: "fixture-only",
    },
  });
};
useWebSocketStore.setState({
  transportMode: "websocket",
  _auth_phase: "authenticated",
  _all_data_initialized: true,
  _server_initialized: true,
  _server_verified: true,
  _initiating: false,
  _heartbeat_time: Date.now(),
  connections: {},
  configStore: query.get("profiles") === "0" ? {} : profiles,
  staticStore: {
    ...useWebSocketStore.getState().staticStore,
    ...(configurationPreview ? configurationStatic : { student_names: [] }),
  },
  eventStore: { alpha: fixtureTasks, beta: fixtureTasks },
  statusStore: {
    alpha: {
      config_id: "alpha",
      running: false,
      current_task: "cafe_reward",
      waiting_tasks: ["collect_daily_power", "create", "collect_reward"],
      timestamp: Date.now(),
    },
    beta: {
      config_id: "beta",
      running: false,
      current_task: null,
      waiting_tasks: [],
      timestamp: Date.now(),
    },
  },
  logStore: Object.fromEntries(
    Object.keys(profiles).map((pid) => [
      `config:${pid}`,
      Array.from({ length: 80 }, (_, index) => ({
        time: new Date(Date.now() - (80 - index) * 1000).toISOString(),
        level:
          query.get("logs") === "1"
            ? homeLogSamples[index % homeLogSamples.length][0]
            : index === 16
              ? "WARNING"
              : "INFO",
        message:
          query.get("logs") === "1"
            ? homeLogSamples[index % homeLogSamples.length][1]
            : index === 16
              ? "Fixture warning: visual verification only; no game action."
              : `${String(index + 1).padStart(3, "0")}  Stage ended with matched RGB feature: main_page`,
      })),
    ])
  ),
  updateStore: { channel: "dev", updateMethod: "github", shaMethod: "github", mirrorcCdk: "" },
  versionStore: {
    local: "a183e1c9b4e5848c3db56e50210b95c64adf13fb",
    remote: "a183e1c9b4e5848c3db56e50210b95c64adf13fb",
  },
  init: async () => {},
  startAuthFlow: blocked,
  submitPassword: blocked,
  connect: blocked,
  connectRemote: blocked,
  recoverTransport: async () => {},
  disconnect: () => {},
  send: () => {},
  setTransportMode: async (transportMode) => {
    useWebSocketStore.setState({ transportMode });
  },
  checkTauriUpdater: async () => {},
  startTauriUpdaterPolling: () => {},
  trigger,
  triggerStream: trigger,
  triggerBinary: (payload, _binary, callback) => trigger(payload, callback),
  modify: (path, patch) => {
    const [pid, scope] = path.split("::");
    for (const [key, value] of Object.entries(patch))
      useWebSocketStore.getState().patch(`${pid}::${scope}/${key}`, value);
  },
});

/** Navigate through the real Sidebar button; Main retains its actual cache and no-profile guard. */
function navigate(page: PageKey) {
  const label = i18n.t(`nav.${page}`);
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-fixture-workspace] button[aria-label]")
  ).find((item) => item.getAttribute("aria-label") === label && item.getClientRects().length > 0);
  button?.click();
}

function Fixture() {
  useAndroidViewport();
  const { theme, setTheme } = useTheme();
  const { setUiSettings } = useUISettings();
  const hasProfiles = useWebSocketStore((state) => Object.keys(state.configStore).length > 0);
  const configurationState = useWebSocketStore((state) =>
    configurationPreview ? state.configStore : null
  );
  const [ready, setReady] = useState(false);
  const [showEditors, setShowEditors] = useState(false);
  const [sampleText, setSampleText] = useState("Alpha bravo charlie");
  const [sampleNote, setSampleNote] = useState("First editable line\nSecond editable line");
  useEffect(() => {
    const timer = window.setInterval(
      () => useWebSocketStore.setState({ _heartbeat_time: Date.now() }),
      3000
    );
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const page =
      query.get("page") ??
      (configurationPreview ? "configuration" : schedulerPreview ? "scheduler" : null);
    if (page === "settings" || page === "scheduler" || page === "configuration") navigate(page);
  }, [ready]);
  return (
    <AppProvider setReady={setReady}>
      <TauriSelfUpdateProvider>
        <TauriShortcutProvider>
          <GlobalAppearanceEffects />
          <div
            className="app-window-frame flex h-full min-h-0 flex-col overflow-hidden text-foreground"
            data-fixture-isolated="true"
          >
            {configurationPreview && (
              <output hidden data-fixture-config-state>
                {JSON.stringify(configurationState)}
              </output>
            )}
            <header
              className="relative z-[1000] flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-sidebar px-2 text-xs"
              data-fixture-controls
            >
              <span className="shrink-0 px-1 text-muted-foreground">Isolated fixture</span>
              <TitlebarMenus />
              <button
                className="shrink-0 rounded px-2 py-1 hover:bg-sidebar-accent"
                onClick={() => navigate("home")}
              >
                Home
              </button>
              <button
                className="shrink-0 rounded px-2 py-1 hover:bg-sidebar-accent"
                onClick={() => navigate("settings")}
              >
                Settings
              </button>
              <button
                className="shrink-0 rounded px-2 py-1 hover:bg-sidebar-accent"
                onClick={() => setShowEditors((visible) => !visible)}
                aria-expanded={showEditors}
              >
                Editors
              </button>
              <button
                data-fixture-action="toggle-profiles"
                className="shrink-0 rounded px-2 py-1 hover:bg-sidebar-accent"
                onClick={() =>
                  useWebSocketStore.setState({ configStore: hasProfiles ? {} : profiles })
                }
              >
                {hasProfiles ? "Remove profiles" : "Restore profiles"}
              </button>
              <button
                className="shrink-0 rounded px-2 py-1 hover:bg-sidebar-accent"
                onClick={() => {
                  const next = theme === "dark" ? "light" : "dark";
                  setTheme(next);
                  setUiSettings((settings) => ({ ...settings, theme: next }));
                }}
              >
                Theme
              </button>
              <LanguageSelect
                handleLanguageChange={(lang) => {
                  void loadLocale(lang).then(() =>
                    setUiSettings((settings) => ({ ...settings, lang }))
                  );
                }}
              />
            </header>
            {showEditors && (
              <section
                className="grid shrink-0 gap-2 border-b border-border bg-background p-3 sm:grid-cols-2"
                aria-label="Isolated edit action samples"
                data-fixture-editors
              >
                <label className="text-xs">
                  Controlled input
                  <input
                    data-fixture-editor="input"
                    className="mt-1 block w-full rounded border border-border bg-background px-2 py-1"
                    value={sampleText}
                    onChange={(event) => setSampleText(event.target.value)}
                  />
                </label>
                <label className="text-xs">
                  Controlled textarea
                  <textarea
                    data-fixture-editor="textarea"
                    className="mt-1 block w-full rounded border border-border bg-background px-2 py-1"
                    rows={2}
                    value={sampleNote}
                    onChange={(event) => setSampleNote(event.target.value)}
                  />
                </label>
                <div
                  data-fixture-editor="contenteditable"
                  contentEditable
                  suppressContentEditableWarning
                  role="textbox"
                  aria-label="Contenteditable sample"
                  className="rounded border border-border px-2 py-1"
                >
                  Editable <strong>formatted</strong> sample
                </div>
                <p
                  data-fixture-selection
                  tabIndex={0}
                  className="select-text rounded border border-border px-2 py-1"
                >
                  Plain document text can be selected and copied, but must never be edited.
                </p>
              </section>
            )}
            <div
              className="app-workspace relative min-h-0 flex-1 overflow-hidden"
              data-fixture-workspace
            >
              <AppMain />
            </div>
          </div>
          <Toaster />
        </TauriShortcutProvider>
      </TauriSelfUpdateProvider>
    </AppProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <UISettingsProvider>
      <AboutBaasProvider>
        <ProfileActionsProvider>
          <WindowLayoutProvider>
            <NavigationHistoryProvider>
              <Fixture />
            </NavigationHistoryProvider>
          </WindowLayoutProvider>
        </ProfileActionsProvider>
      </AboutBaasProvider>
    </UISettingsProvider>
  </ThemeProvider>
);
