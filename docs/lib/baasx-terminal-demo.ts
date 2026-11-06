/** A bounded, process-free teaching model. No network, storage, shell, or BAAS client. */
export type DemoLocale = "zh" | "en";
export type DemoScenario = "quickstart" | "configuration" | "scheduler" | "packs";
export type DemoPage =
  | "home"
  | "tasks"
  | "oneoff"
  | "profiles"
  | "config"
  | "counts"
  | "priority"
  | "scheduler"
  | "schedule"
  | "packs"
  | "logs"
  | "help";
export type DemoKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "escape"
  | "space"
  | "save"
  | "plus"
  | "minus";
export type DemoAction =
  | { type: "command"; value: string }
  | { type: "key"; key: DemoKey }
  | { type: "value"; value: string }
  | { type: "tick" }
  | { type: "reset"; locale: DemoLocale; scenario: DemoScenario };
type Schedule = { id: string; enabled: boolean; priority: number; interval: number };
type Pending =
  | { kind: "run"; id: string }
  | { kind: "pack"; id: string }
  | { kind: "save"; page: "counts" | "priority" | "schedule" }
  | { kind: "stop" };
export interface DemoState {
  locale: DemoLocale;
  scenario: DemoScenario;
  page: DemoPage;
  profile: string;
  selected: number;
  counts: number[];
  priority: string[];
  schedule: Schedule[];
  draftCounts: number[];
  draftPriority: string[];
  draftSchedule: Schedule[];
  taskIndex: number;
  pending?: Pending;
  cancelSelected?: boolean;
  editValue?: string;
  running?: { id: string; tick: number; total: number };
  logs: string[];
  notice: string;
  revision: number;
}
export interface DemoStep {
  title: [string, string];
  description: [string, string];
  action: DemoAction;
}
export const demoText = (locale: DemoLocale, zh: string, en: string) => (locale === "zh" ? zh : en);
const taskNames: Record<string, [string, string]> = {
  collect_reward: ["收取奖励", "Collect rewards"],
  cafe: ["咖啡厅", "Café"],
  mail: ["邮件", "Mail"],
  start_normal_task: ["普通关卡推图", "Normal progression"],
  start_main_story: ["主线剧情", "Main story"],
  start_explore_activity_story: ["活动剧情", "Event story"],
};
const oneoffs = ["start_normal_task", "start_main_story", "start_explore_activity_story"];
const packs = ["briefing", "connection-check", "daily", "daily-wait"];
const materials: Record<string, [string, string]> = {
  "花": ["花", "Flower"],
  "金属": ["金属", "Metal"],
  "闪耀": ["闪耀", "Radiant"],
};
export const supportedDemoCommands = [
  "/help",
  "/home",
  "/tasks",
  "/profiles",
  "/use",
  "/config",
  "/scheduler",
  "/start",
  "/stop",
  "/run",
  "/oneoff",
  "/reload",
  "/packs",
  "/pack",
  "/logs",
  "/status",
];
const word = (state: DemoState, zh: string, en: string) => demoText(state.locale, zh, en);
const taskLabel = (state: DemoState, id: string) =>
  taskNames[id]?.[state.locale === "zh" ? 0 : 1] ?? id;
const log = (state: DemoState, message: string) => ({
  ...state,
  logs: [...state.logs, message].slice(-30),
  notice: message,
});
const opened = (state: DemoState, page: DemoPage) => ({
  ...state,
  page,
  selected: 0,
  pending: undefined,
  editValue: undefined,
  notice: "",
});

export function initialDemo(locale: DemoLocale, scenario: DemoScenario): DemoState {
  const schedule = [
    { id: "collect_reward", enabled: true, priority: 0, interval: 86400 },
    { id: "cafe", enabled: true, priority: 10, interval: 21600 },
    { id: "mail", enabled: true, priority: 20, interval: 86400 },
  ];
  return {
    locale,
    scenario,
    page: scenario === "configuration" ? "config" : scenario === "quickstart" ? "home" : scenario,
    profile: "Sensei Demo",
    selected: 0,
    counts: [1, 0, 1, 1],
    priority: ["花", "金属", "闪耀"],
    schedule,
    draftCounts: [1, 0, 1, 1],
    draftPriority: ["花", "金属", "闪耀"],
    draftSchedule: schedule.map((task) => ({ ...task })),
    taskIndex: 0,
    logs: [],
    notice: demoText(
      locale,
      "离线示例已就绪。输入 /help 或选择演示步骤。",
      "Offline sample ready. Type /help or choose a guided step."
    ),
    revision: 0,
  };
}

function start(state: DemoState, id: string): DemoState {
  if (state.running)
    return log(
      state,
      word(
        state,
        "已有示例运行；先 /stop，再启动下一项。",
        "A sample run is active. Use /stop before starting another."
      )
    );
  if (id === "scheduler" && !state.schedule.some((task) => task.enabled))
    return log(
      state,
      word(
        state,
        "没有启用的日常任务。请先编辑调度。",
        "No daily tasks are enabled. Edit the schedule first."
      )
    );
  const message = word(
    state,
    "DEMO · 请求已提交，尚未完成。",
    "DEMO · Request accepted; not completed yet."
  );
  return log(
    { ...opened(state, "logs"), running: { id, tick: 0, total: id === "scheduler" ? 10 : 4 } },
    message
  );
}

function confirm(state: DemoState): DemoState {
  const pending = state.pending;
  if (!pending) return state;
  let next = { ...state, pending: undefined, cancelSelected: false };
  if (pending.kind === "run") return start(next, pending.id);
  if (pending.kind === "stop")
    return log(
      { ...next, running: undefined },
      word(state, "DEMO · 已停止示例运行。", "DEMO · Sample run stopped.")
    );
  if (pending.kind === "pack") {
    if (pending.id === "daily" || pending.id === "daily-wait") return start(next, "scheduler");
    return log(
      opened(next, "logs"),
      pending.id === "briefing"
        ? word(
            state,
            `DEMO · status → tasks：${state.schedule.filter((task) => task.enabled).length} 项任务已启用。`,
            `DEMO · status → tasks: ${state.schedule.filter((task) => task.enabled).length} tasks enabled.`
          )
        : word(
            state,
            "DEMO · status → devices：示例设备可用（未连接任何设备）。",
            "DEMO · status → devices: sample device available (no device connected)."
          )
    );
  }
  if (pending.page === "counts") next = { ...next, counts: [...state.draftCounts] };
  if (pending.page === "priority") next = { ...next, priority: [...state.draftPriority] };
  if (pending.page === "schedule")
    next = { ...next, schedule: state.draftSchedule.map((task) => ({ ...task })) };
  return log(
    opened(next, pending.page === "schedule" ? "scheduler" : "config"),
    word(state, "演示修改已保存，仅保留在当前网页。", "Sample changes saved in this page only.")
  );
}

function command(state: DemoState, input: string): DemoState {
  const [raw, ...args] = input.trim().replace(/^\//, "").split(/\s+/);
  const name = raw?.toLowerCase();
  if (!name) return state;
  if (state.pending)
    return log(
      state,
      word(state, "请先确认或取消当前操作。", "Confirm or cancel the pending action first.")
    );
  if (name === "reload")
    return log(
      { ...opened(state, "home"), revision: state.revision + 1 },
      word(
        state,
        "工作台已重载；已保存设置和后台示例运行保留。",
        "Workspace reloaded; saved settings and the sample run are retained."
      )
    );
  if (name === "start") return start(state, "scheduler");
  if (name === "use") {
    const profile = args.join(" ").toLowerCase();
    if (!profile) return opened(state, "profiles");
    if (profile !== "sensei-demo" && profile !== "sensei demo")
      return log(
        state,
        word(
          state,
          "示例仅提供 sensei-demo 配置档。",
          "Only the sensei-demo profile is available in this sample."
        )
      );
    return log(opened(state, "home"), word(state, "已选择 Sensei Demo。", "Selected Sensei Demo."));
  }
  if (name === "stop")
    return state.running
      ? { ...state, pending: { kind: "stop" }, notice: "" }
      : log(state, word(state, "当前没有示例运行。", "No sample run is active."));
  if (name === "status")
    return log(
      state,
      state.running
        ? word(
            state,
            "DEMO · 运行中；结果尚未确定。",
            "DEMO · Running; the outcome is not known yet."
          )
        : word(
            state,
            "DEMO · 已连接本地示例，空闲。",
            "DEMO · Connected to the local sample, idle."
          )
    );
  if (name === "run") {
    if (!args[0]) return opened(state, "tasks");
    if (!Object.hasOwn(taskNames, args[0]))
      return log(
        state,
        word(
          state,
          "此演示未提供该任务。用 /tasks 或 /oneoff 查看示例。",
          "This demo has no such task. Open /tasks or /oneoff for sample IDs."
        )
      );
    return { ...state, pending: { kind: "run", id: args[0] }, notice: "" };
  }
  if (name === "pack") {
    if (!args[0]) return opened(state, "packs");
    if (!packs.includes(args[0]))
      return log(
        state,
        word(
          state,
          "此演示仅提供四个内置指令包。",
          "This demo includes the four built-in command packs."
        )
      );
    const plan: DemoState = { ...state, pending: { kind: "pack", id: args[0] }, notice: "" };
    return args[0] === "briefing" || args[0] === "connection-check" ? confirm(plan) : plan;
  }
  if (
    [
      "home",
      "tasks",
      "oneoff",
      "profiles",
      "config",
      "scheduler",
      "packs",
      "logs",
      "help",
    ].includes(name)
  )
    return opened(state, name as DemoPage);
  return log(
    state,
    word(
      state,
      "此网页只模拟列出的命令。输入 /help 查看范围。",
      "This page simulates only its listed commands. Type /help for the supported subset."
    )
  );
}

function rowCount(state: DemoState): number {
  if (state.page === "tasks") return state.schedule.length + 1;
  if (state.page === "oneoff") return oneoffs.length;
  if (state.page === "config") return 2;
  if (state.page === "counts") return state.draftCounts.length;
  if (state.page === "priority") return Object.keys(materials).length;
  if (state.page === "scheduler") return state.schedule.length;
  if (state.page === "schedule") return 3;
  if (state.page === "packs") return packs.length;
  return 1;
}

function key(state: DemoState, input: DemoKey): DemoState {
  if (state.pending) {
    if (input === "left" || input === "right" || input === "up" || input === "down")
      return { ...state, cancelSelected: !state.cancelSelected };
    if (input === "enter" && !state.cancelSelected) return confirm(state);
    if (input === "escape" || input === "enter")
      return log(
        { ...state, pending: undefined, cancelSelected: false },
        word(state, "已取消；未修改演示数据。", "Cancelled; sample data was not changed.")
      );
    return state;
  }
  if (state.editValue !== undefined) {
    if (input === "escape") return { ...state, editValue: undefined };
    if (input !== "enter") return state;
    const value = Number(state.editValue);
    if (!state.editValue.trim() || !Number.isSafeInteger(value))
      return log(state, word(state, "请输入有效整数。", "Enter a valid integer."));
    if (state.page === "counts" && (value < 0 || value > 99))
      return log(state, word(state, "次数必须在 0–99 之间。", "Counts must be between 0 and 99."));
    if (state.page === "schedule" && state.selected === 2 && value < 0)
      return log(
        state,
        word(state, "间隔必须是非负整数。", "The interval must be a nonnegative integer.")
      );
    if (state.page === "counts")
      return {
        ...state,
        editValue: undefined,
        draftCounts: state.draftCounts.map((count, index) =>
          index === state.selected ? value : count
        ),
        notice: "",
      };
    return {
      ...state,
      editValue: undefined,
      notice: "",
      draftSchedule: state.draftSchedule.map((task, index) =>
        index === state.taskIndex
          ? { ...task, [state.selected === 1 ? "priority" : "interval"]: value }
          : task
      ),
    };
  }
  if (input === "escape")
    return opened(
      state,
      ["counts", "priority"].includes(state.page)
        ? "config"
        : state.page === "schedule"
          ? "scheduler"
          : "home"
    );
  if (input === "up" || input === "down")
    return {
      ...state,
      selected: Math.max(
        0,
        Math.min(rowCount(state) - 1, state.selected + (input === "down" ? 1 : -1))
      ),
    };
  if (input === "save" && ["counts", "priority", "schedule"].includes(state.page))
    return {
      ...state,
      pending: { kind: "save", page: state.page as "counts" | "priority" | "schedule" },
      notice: "",
    };
  if (state.page === "counts") {
    if (input === "plus" || input === "minus")
      return {
        ...state,
        draftCounts: state.draftCounts.map((count, index) =>
          index === state.selected
            ? Math.max(0, Math.min(99, count + (input === "plus" ? 1 : -1)))
            : count
        ),
      };
    if (input === "enter")
      return { ...state, editValue: String(state.draftCounts[state.selected]), notice: "" };
  }
  if (state.page === "priority") {
    const choices = [
      ...state.draftPriority,
      ...Object.keys(materials).filter((item) => !state.draftPriority.includes(item)),
    ];
    const current = choices[state.selected];
    const at = state.draftPriority.indexOf(current);
    if (input === "space")
      return {
        ...state,
        selected: 0,
        draftPriority:
          at < 0
            ? [...state.draftPriority, current]
            : state.draftPriority.filter((item) => item !== current),
      };
    if ((input === "left" || input === "right") && at >= 0) {
      const target = at + (input === "left" ? -1 : 1);
      if (target < 0 || target >= state.draftPriority.length) return state;
      const values = [...state.draftPriority];
      [values[at], values[target]] = [values[target], values[at]];
      return { ...state, draftPriority: values, selected: target };
    }
  }
  if (state.page === "schedule" && (input === "enter" || input === "space")) {
    if (state.selected === 0)
      return {
        ...state,
        draftSchedule: state.draftSchedule.map((task, index) =>
          index === state.taskIndex ? { ...task, enabled: !task.enabled } : task
        ),
      };
    return {
      ...state,
      editValue: String(
        state.draftSchedule[state.taskIndex][state.selected === 1 ? "priority" : "interval"]
      ),
      notice: "",
    };
  }
  if (input !== "enter") return state;
  if (state.page === "profiles")
    return log(opened(state, "home"), word(state, "已选择 Sensei Demo。", "Selected Sensei Demo."));
  if (state.page === "tasks")
    return state.selected === state.schedule.length
      ? opened(state, "oneoff")
      : { ...state, pending: { kind: "run", id: state.schedule[state.selected].id } };
  if (state.page === "oneoff")
    return { ...state, pending: { kind: "run", id: oneoffs[state.selected] } };
  if (state.page === "packs") return command(state, `/pack ${packs[state.selected]}`);
  if (state.page === "config")
    return {
      ...opened(state, state.selected === 0 ? "counts" : "priority"),
      draftCounts: [...state.counts],
      draftPriority: [...state.priority],
    };
  if (state.page === "scheduler")
    return {
      ...opened(state, "schedule"),
      taskIndex: state.selected,
      draftSchedule: state.schedule.map((task) => ({ ...task })),
    };
  return state;
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  if (action.type === "reset") return initialDemo(action.locale, action.scenario);
  if (action.type === "command") return command(state, action.value.slice(0, 300));
  if (action.type === "key") return key(state, action.key);
  if (action.type === "value")
    return state.editValue === undefined
      ? state
      : { ...state, editValue: action.value.slice(0, 12) };
  if (!state.running) return state;
  const tick = state.running.tick + 1;
  if (tick >= state.running.total)
    return log(
      { ...state, running: undefined },
      word(
        state,
        "DEMO · 示例运行完成，exit_code=0。未执行游戏操作。",
        "DEMO · Sample run completed, exit_code=0. No game action was performed."
      )
    );
  return log(
    { ...state, running: { ...state.running, tick } },
    word(
      state,
      `DEMO · ${tick}/${state.running.total}：处理示例步骤…`,
      `DEMO · ${tick}/${state.running.total}: processing a sample step…`
    )
  );
}

export function demoRows(state: DemoState): string[] {
  const t = (zh: string, en: string) => word(state, zh, en);
  const pick = (line: string, index: number) => `${state.selected === index ? "❯" : " "} ${line}`;
  if (state.pending)
    return [
      t("确认此演示操作", "Confirm this sample action"),
      "",
      state.pending.kind === "save"
        ? t("保存草稿到当前网页的示例状态", "Save the draft into this page's sample state")
        : state.pending.kind === "stop"
          ? t("停止当前示例运行", "Stop the current sample run")
          : `${state.pending.kind === "pack" ? "pack" : "run"} ${state.pending.id}`,
      ...(state.pending.kind === "pack" ? packPlan(state.pending.id) : []),
      "",
      state.cancelSelected
        ? t("  确认           ❯ 取消 [Enter/Esc]", "  Confirm          ❯ Cancel [Enter/Esc]")
        : t("❯ 确认 [Enter]     取消 [Esc]", "❯ Confirm [Enter]     Cancel [Esc]"),
    ];
  if (state.editValue !== undefined)
    return [
      t("编辑数字 · 当前输入", "Edit number · Current input"),
      `❯ ${state.editValue}`,
      "",
      state.page === "counts"
        ? t(
            "次数范围 0–99；Enter 返回，Ctrl+S 保存草稿。",
            "Counts: 0–99. Enter returns; Ctrl+S saves the draft."
          )
        : t(
            "priority 可为负整数，interval 为非负秒数。",
            "Priority accepts signed integers; interval uses nonnegative seconds."
          ),
    ];
  switch (state.page) {
    case "profiles":
      return [
        pick("● Sensei Demo   sensei-demo", 0),
        "",
        t("Enter 选择配置档 · /use sensei-demo", "Enter selects the profile · /use sensei-demo"),
        t(
          "本页提供一个演示配置档，所有修改仅在浏览器内存中保留。",
          "One sample profile is available; edits stay in browser memory."
        ),
      ];
    case "home":
      return [
        t("欢迎回来，老师。", "Welcome back, Sensei."),
        t("这是可交互的网页教学模型。", "This is an interactive browser teaching model."),
        "",
        t(
          `日常任务：${state.schedule.filter((task) => task.enabled).length}/3 已启用`,
          `Daily tasks: ${state.schedule.filter((task) => task.enabled).length}/3 enabled`
        ),
        t(`日程次数：${state.counts.join(" / ")}`, `Lesson counts: ${state.counts.join(" / ")}`),
        t(
          `制造优先级：${state.priority.join(" › ")}`,
          `Crafting priority: ${state.priority.map((item) => materials[item][1]).join(" › ")}`
        ),
        "",
        "/tasks   /config   /scheduler   /packs",
        t("输入 /help 查看支持的操作。", "Type /help for supported operations."),
      ];
    case "tasks":
      return [
        ...state.schedule.map((task, index) =>
          pick(`${taskLabel(state, task.id)}  ${task.enabled ? "●" : "○"}  ${task.id}`, index)
        ),
        pick(t("一次性任务 →", "One-off tasks →"), state.schedule.length),
        "",
        t(
          "Enter 选择单项任务；/start 直接启动日常调度。",
          "Enter selects one task; /start launches the daily schedule directly."
        ),
      ];
    case "oneoff":
      return [
        ...oneoffs.map((id, index) => pick(`${taskLabel(state, id)}  ${id}`, index)),
        "",
        t(
          "一次性任务不加入日常调度。此处仅展示部分示例。",
          "One-off tasks do not join the daily schedule. A subset is shown here."
        ),
      ];
    case "config":
      return [
        pick(t("日程 · 各区域次数", "Lessons · Counts by area"), 0),
        pick(t("制造 · 第一阶段优先级", "Crafting · Phase-one priorities"), 1),
        "",
        t(
          "教学模型仅展示这两类字段；正式版包含完整配置分类。",
          "This model shows two field types; the app includes the full category list."
        ),
      ];
    case "counts":
      return [
        t("区域              次数", "Area               Count"),
        ...state.draftCounts.map((count, index) =>
          pick(`${t("示例校区", "Sample area")} ${index + 1}       [-] ${count} [+]`, index)
        ),
        "",
        t(
          "+/- 调整 · Enter 输入 · Ctrl+S 保存 · Esc 放弃",
          "+/- adjust · Enter edit · Ctrl+S save · Esc discard"
        ),
      ];
    case "priority":
      return [
        ...[
          ...state.draftPriority,
          ...Object.keys(materials).filter((item) => !state.draftPriority.includes(item)),
        ].map((item, index) =>
          pick(
            `${state.draftPriority.includes(item) ? `${state.draftPriority.indexOf(item) + 1}.` : "○"} ${materials[item][state.locale === "zh" ? 0 : 1]}`,
            index
          )
        ),
        "",
        t(
          "越靠上优先级越高；←→ 移动，Space 添加/移除。",
          "Higher rows take priority; ←→ move, Space adds/removes."
        ),
        t("Ctrl+S 保存草稿；Esc 放弃。", "Ctrl+S saves the draft; Esc discards it."),
      ];
    case "scheduler":
      return [
        ...state.schedule.map((task, index) =>
          pick(
            `${task.enabled ? "●" : "○"} ${taskLabel(state, task.id)}  priority=${task.priority}`,
            index
          )
        ),
        "",
        t(
          "Enter 打开任务字段；数字越小，调度优先级越高。",
          "Enter opens fields; lower numbers mean higher schedule priority."
        ),
      ];
    case "schedule": {
      const task = state.draftSchedule[state.taskIndex];
      return [
        taskLabel(state, task.id),
        ...[
          `${t("启用", "Enabled")}: ${task.enabled ? "on" : "off"}`,
          `priority: ${task.priority}`,
          `interval: ${task.interval} s`,
        ].map(pick),
        "",
        t(
          "Enter 编辑 · Ctrl+S 保存 · 此演示仅含三个字段",
          "Enter edits · Ctrl+S saves · Three fields are modeled here"
        ),
      ];
    }
    case "packs":
      return [
        ...packs.map((pack, index) => pick(pack, index)),
        "",
        t(
          "指令包是声明式 BAAS 操作，与客户端插件分开。",
          "Packs declare BAAS actions and are separate from client plugins."
        ),
        t(
          "Enter 查看计划并确认，不执行任意脚本。",
          "Enter previews a plan and asks for confirmation; no arbitrary scripts."
        ),
      ];
    case "logs":
      return state.logs.length ? state.logs : [t("暂无示例日志。", "No sample logs yet.")];
    case "help":
      return [
        t("/home        返回总览", "/home        Return to the overview"),
        t(
          "/tasks       查看日常任务；Enter 选择运行",
          "/tasks       Browse daily tasks; Enter selects a run"
        ),
        t("/run mail    确认后单独运行邮件任务", "/run mail    Run mail after confirmation"),
        t(
          "/oneoff      剧情、推图等一次性任务",
          "/oneoff      Run a story or progression task once"
        ),
        t("/profiles    选择配置档", "/profiles    Choose a profile"),
        t(
          "/use sensei-demo  直接选择演示配置档",
          "/use sensei-demo  Select the demo profile directly"
        ),
        t(
          "/config      编辑日程次数和制造优先级",
          "/config      Edit lesson counts and crafting priorities"
        ),
        t(
          "/scheduler   编辑日常任务的启用状态与优先级",
          "/scheduler   Edit enabled state and task priorities"
        ),
        t(
          "/start       立即启动日常调度，无需确认",
          "/start       Start scheduling immediately, without confirmation"
        ),
        t(
          "/stop        确认后停止当前运行",
          "/stop        Stop the current run after confirmation"
        ),
        t("/logs        查看运行日志", "/logs        View runtime logs"),
        t("/status      读取当前运行状态", "/status      Inspect the current runtime state"),
        t("/packs       查看内置指令包", "/packs       Browse built-in command packs"),
        t(
          "/pack briefing  读取状态与任务，无需确认",
          "/pack briefing  Read status and tasks without confirmation"
        ),
        t(
          "/reload      重载界面；保留已保存配置与当前运行",
          "/reload      Reload the UI; keep saved settings and active runs"
        ),
        t("/help        查看命令作用与按键", "/help        Explain commands and keyboard controls"),
        "",
        t(
          "↑↓ 选择，Enter 打开/确认，Esc 返回/取消。",
          "↑↓ select, Enter opens/confirms, Esc goes back/cancels."
        ),
        t(
          "配置：←→ 调整顺序，+/- 次数，Ctrl+S 保存。",
          "Configuration: ←→ order, +/- count, Ctrl+S save."
        ),
        t(
          "模拟仅覆盖本页教学操作，所有数据都在内存中。",
          "Only this page's teaching flows are modeled; all data stays in memory."
        ),
      ];
  }
}

export function packPlan(id: string): string[] {
  return id === "briefing"
    ? ["1. status", "2. tasks"]
    : id === "connection-check"
      ? ["1. status", "2. devices"]
      : id === "daily-wait"
        ? ["1. scheduler_start", "2. wait_run (timeout_seconds: 120)"]
        : ["1. scheduler_start"];
}

const commandStep = (
  value: string,
  title: [string, string],
  description: [string, string]
): DemoStep => ({ title, description, action: { type: "command", value } });
const keyStep = (
  key: DemoKey,
  title: [string, string],
  description: [string, string]
): DemoStep => ({ title, description, action: { type: "key", key } });
export function demoSteps(scenario: DemoScenario): DemoStep[] {
  if (scenario === "configuration")
    return [
      commandStep(
        "/config",
        ["打开配置", "Open configuration"],
        [
          "先选择配置类别，再打开字段。演示提供日程次数和制造优先级。",
          "Choose a category, then a field. This demo offers lesson counts and crafting priorities.",
        ]
      ),
      keyStep(
        "enter",
        ["打开区域表格", "Open the area table"],
        [
          "所有示例校区都有次数，包括次数为零的区域。",
          "Every sample area has an editable count, including zero-count areas.",
        ]
      ),
      keyStep(
        "down",
        ["选择第二区域", "Select area two"],
        ["↑↓ 或下方按钮选择区域。", "Use ↑↓ or the controls below to select an area."]
      ),
      keyStep(
        "plus",
        ["增加次数", "Increase the count"],
        [
          "按 + 增加，按 - 减少，Enter 可直接输入。修改仍是草稿。",
          "+ increases, - decreases, and Enter opens direct input. This is still a draft.",
        ]
      ),
      keyStep(
        "save",
        ["保存草稿", "Save the draft"],
        [
          "Ctrl+S 提交整个字段，检查确认信息。",
          "Ctrl+S submits the field; review the confirmation.",
        ]
      ),
      keyStep(
        "enter",
        ["确认保存", "Confirm the change"],
        ["此处只更新网页示例数据。", "Only the browser sample changes here."]
      ),
      keyStep(
        "down",
        ["选择制造优先级", "Select crafting priorities"],
        ["实际保存顺序决定条目的优先级。", "The saved order determines item priority."]
      ),
      keyStep(
        "enter",
        ["打开顺序编辑", "Open the ordered editor"],
        [
          "编号与保存顺序一致，越靠上优先级越高。",
          "Numbers match the saved order; higher entries take priority.",
        ]
      ),
      keyStep(
        "right",
        ["下移首项", "Move the first item down"],
        [
          "→ 下移，← 上移；光标跟随条目。",
          "→ moves down and ← moves up; selection follows the item.",
        ]
      ),
      keyStep(
        "save",
        ["保存新顺序", "Save the new order"],
        ["Ctrl+S 提交，Esc 可放弃当前草稿。", "Ctrl+S submits; Esc discards the current draft."]
      ),
      keyStep(
        "enter",
        ["确认顺序", "Confirm the order"],
        [
          "保存的是条目值和顺序，而非翻译后的显示名称。",
          "Values and order are saved, independently of translated labels.",
        ]
      ),
    ];
  if (scenario === "scheduler")
    return [
      commandStep(
        "/scheduler",
        ["打开调度", "Open the scheduler"],
        [
          "调度是当前配置档的日常任务安排，与一次性任务分开。",
          "The current profile's daily schedule is separate from one-off tasks.",
        ]
      ),
      keyStep(
        "enter",
        ["编辑任务字段", "Edit task fields"],
        [
          "正式版还有下次执行时间、每日重置和前后置任务等字段。",
          "The full app also provides next execution, daily resets, and pre/post tasks.",
        ]
      ),
      keyStep(
        "space",
        ["切换启用状态", "Toggle enabled"],
        ["禁用任务不会删除其配置。", "Disabling a task keeps its configuration."]
      ),
      keyStep(
        "save",
        ["保存调度", "Save the schedule"],
        [
          "真实应用会检查并发修改，不会静默覆盖其他修改。",
          "The real app checks concurrent edits instead of silently overwriting them.",
        ]
      ),
      keyStep(
        "enter",
        ["确认修改", "Confirm the change"],
        ["启用数量立即反映新的安排。", "The enabled count immediately reflects the change."]
      ),
      commandStep(
        "/start",
        ["启动日常调度", "Start the schedule"],
        [
          "/start 直接启动；已提交不等于任务已完成。",
          "/start launches directly; accepted does not mean completed.",
        ]
      ),
      commandStep(
        "/stop",
        ["停止示例", "Stop the sample"],
        [
          "停止操作需要确认，确认前运行状态保持不变。",
          "Stopping asks for confirmation; the run stays active until confirmed.",
        ]
      ),
      keyStep(
        "enter",
        ["确认停止", "Confirm stop"],
        [
          "真实任务结果应以运行日志和退出状态为准。",
          "For real tasks, rely on runtime logs and exit status.",
        ]
      ),
    ];
  if (scenario === "packs")
    return [
      commandStep(
        "/packs",
        ["查看内置指令包", "Browse built-in packs"],
        [
          "CLI 指令包与桌面客户端插件是两套机制。",
          "CLI command packs and desktop plugins are separate mechanisms.",
        ]
      ),
      commandStep(
        "/pack briefing",
        ["运行 briefing", "Run briefing"],
        [
          "只读计划直接读取状态和任务，无需确认，不启动游戏操作。",
          "This read-only plan reads status and tasks immediately without confirmation or game actions.",
        ]
      ),
      commandStep(
        "/pack daily-wait",
        ["预览 daily-wait", "Preview daily-wait"],
        [
          "计划启动已有日常调度，再等待该次运行。",
          "The plan starts the existing daily schedule, then waits for that run.",
        ]
      ),
      keyStep(
        "escape",
        ["取消计划", "Cancel the plan"],
        [
          "取消后不会执行任何步骤。自定义包只允许声明受支持的 BAAS 操作。",
          "Cancellation executes no steps. Custom packs may declare only supported BAAS actions.",
        ]
      ),
      commandStep(
        "/reload",
        ["重载工作台", "Reload the workspace"],
        [
          "正式版会重新读取指令包与设置；这里保留当前网页示例。",
          "The real app rereads packs and settings; this model retains its browser sample.",
        ]
      ),
    ];
  return [
    commandStep(
      "/tasks",
      ["查看任务", "Browse tasks"],
      [
        "日常任务与一次性任务入口分开。也可输入 /run mail。",
        "Daily and one-off task entries are separate. You can also type /run mail.",
      ]
    ),
    commandStep(
      "/start",
      ["直接启动", "Start directly"],
      [
        "/start 无需确认，启动当前配置档的调度。",
        "/start needs no confirmation and starts the current profile's schedule.",
      ]
    ),
    commandStep(
      "/logs",
      ["观察日志", "Watch logs"],
      [
        "这里的进度为教学模拟；真实任务需要查看实际后端结果。",
        "Progress here is simulated; real tasks require actual backend results.",
      ]
    ),
    commandStep(
      "/stop",
      ["请求停止", "Request stop"],
      ["停止操作提供明确的确认入口。", "Stopping provides an explicit confirmation step."]
    ),
    keyStep(
      "enter",
      ["确认停止", "Confirm stop"],
      ["确认后结束示例运行。", "Confirmation ends the sample run."]
    ),
    commandStep(
      "/oneoff",
      ["查看一次性任务", "Browse one-off tasks"],
      [
        "剧情、推图等一次性操作不会加入日常调度。",
        "Stories and progression runs do not join the daily schedule.",
      ]
    ),
    commandStep(
      "/reload",
      ["回到主页", "Return home"],
      [
        "重载重建界面，保留已保存设置及已有后台运行。",
        "Reload rebuilds the interface while retaining saved settings and any active run.",
      ]
    ),
  ];
}
