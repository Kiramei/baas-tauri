import { randomUUID } from "node:crypto";
import type {
  BaasLogEntry,
  BaasPatchOptions,
  BaasStatusSnapshot,
  BaasStatusUpdate,
  BaasEventChange,
} from "@baas/client";

function demoConfiguration(name: string, server: string): Record<string, unknown> {
  return {
    name,
    server,
    screenshot_method: "adb",
    control_method: "adb",
    new_event_enable_state: "default",
    cafe_reward_use_invitation_ticket: true,
    cafe_reward_has_no2_cafe: false,
    cafe_reward_invite1_criterion: "name",
    favorStudent1: [server === "日服" || server === "JP" ? "アリス" : "爱丽丝"],
    patStyle: "普通",
    cafe_reward_affection_pat_round: 5,
    mainlinePriority: "1-1-3",
    open_emulator_stat: false,
    program_address: "",
    multiEmulatorName: "mumu",
    create_phase: 1,
    create_phase_1_select_item_rule: "default",
    createPriority_phase1: ["花", "金属"],
  };
}

/** Explicit process-local sandbox; no network, devices or real configuration are touched. */
export class DemoClient {
  private state: BaasStatusSnapshot = Object.fromEntries(
    ["sensei-cn", "sensei-jp"].map((id) => [
      id,
      { running: false, current_task: null, waiting_tasks: [], exit_code: null, run_id: null },
    ])
  );
  private configs: Record<string, Record<string, unknown>> = {
    "sensei-cn": demoConfiguration("夏莱 · 国服", "官服"),
    "sensei-jp": demoConfiguration("夏莱 · 日服", "日服"),
  };
  private logEntries: BaasLogEntry[] = [
    {
      scope: "global",
      time: new Date().toISOString(),
      level: "INFO",
      message: "演示环境就绪；未连接真实设备。",
    },
  ];
  private logListeners = new Set<(entry: BaasLogEntry) => void>();
  private statusListeners = new Set<
    (update: BaasStatusUpdate, snapshot: BaasStatusSnapshot) => void
  >();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private schedules: Record<string, Record<string, any>[]> = {};
  async connect() {}
  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  async profiles() {
    return Object.fromEntries(
      Object.entries(this.configs).map(([id, config]) => [id, String(config.name || id)])
    );
  }
  get statusSnapshot() {
    return structuredClone(this.state);
  }
  async status() {
    return this.statusSnapshot;
  }
  async config(id: string) {
    this.check(id);
    return structuredClone(this.configs[id]);
  }
  async staticData(): Promise<Record<string, unknown>> {
    // A deliberately small fixture with the same keys and wire values as backend static.
    return {
      student_names: [
        { CN_name: "爱丽丝", JP_name: "アリス", Global_name: "Aris" },
        { CN_name: "优香", JP_name: "ユウカ", Global_name: "Yuuka" },
      ],
      screenshot_methods: ["adb", "scrcpy"],
      control_methods: ["adb", "scrcpy"],
      create_default_priority: {
        CN: { phase1: ["花", "金属"] },
        JP: { phase1: ["花", "金属"] },
      },
      explore_normal_task_region_range: [4, 30],
      explore_hard_task_region_range: [1, 30],
      lesson_region_name: { CN: ["校区一"], JP: ["エリア一"] },
    };
  }
  async tasks(id: string) {
    this.check(id);
    return Object.fromEntries((await this.events(id)).map((task) => [task.func_name, task]));
  }
  async events(id: string): Promise<Record<string, any>[]> {
    this.check(id);
    this.schedules[id] ||= [
      {
        func_name: "collect_reward",
        event_name: "收取奖励",
        enabled: true,
        priority: 0,
        interval: 86400,
        next_tick: Math.floor(Date.now() / 1000),
        daily_reset: [[4, 0, 0]],
        disabled_time_range: [],
        pre_task: [],
        post_task: [],
      },
      {
        func_name: "cafe",
        event_name: "咖啡厅",
        enabled: true,
        priority: 10,
        interval: 21600,
        next_tick: Math.floor(Date.now() / 1000) + 300,
        daily_reset: [
          [4, 0, 0],
          [16, 0, 0],
        ],
        disabled_time_range: [
          [
            [0, 0, 0],
            [3, 59, 59],
          ],
        ],
        pre_task: [],
        post_task: ["mail"],
      },
      {
        func_name: "mail",
        event_name: "邮件",
        enabled: true,
        priority: 20,
        interval: 86400,
        next_tick: Math.floor(Date.now() / 1000) + 600,
        daily_reset: [[4, 0, 0]],
        disabled_time_range: [],
        pre_task: [],
        post_task: [],
      },
    ];
    return structuredClone(this.schedules[id]);
  }
  async patchEvents(id: string, changes: BaasEventChange[]): Promise<Record<string, any>[]> {
    const draft = await this.events(id);
    for (const change of changes) {
      const task = draft.find((item) => item.func_name === change.func_name);
      if (
        !task ||
        Object.entries(change.expected || {}).some(
          ([key, value]) => JSON.stringify(task[key]) !== JSON.stringify(value)
        )
      )
        throw new Error("调度在确认期间发生变化，请重新读取后再修改");
      for (const key of Object.keys(change.fields))
        if (
          !Object.hasOwn(task, key) ||
          ["func_name", "__proto__", "constructor", "prototype"].includes(key)
        )
          throw new Error("调度字段不可编辑");
      Object.assign(task, structuredClone(change.fields));
    }
    this.schedules[id] = draft;
    this.log(id, "演示调度已保存");
    return this.events(id);
  }
  async logs(limit = 30, profile?: string) {
    return structuredClone(
      this.logEntries
        .filter((entry) => !profile || entry.scope === `config:${profile}`)
        .slice(-limit)
    );
  }
  onLog(listener: (entry: BaasLogEntry) => void) {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }
  onStatus(listener: (update: BaasStatusUpdate, snapshot: BaasStatusSnapshot) => void) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }
  onDisconnect(_listener: (error: Error) => void) {
    return () => {};
  }
  private publish(id: string) {
    for (const listener of this.statusListeners)
      listener(
        { full: false, configId: id, status: structuredClone(this.state[id]) },
        this.statusSnapshot
      );
  }
  private log(id: string, message: string) {
    const entry = { scope: `config:${id}`, time: new Date().toISOString(), level: "INFO", message };
    this.logEntries.push(entry);
    if (this.logEntries.length > 500) this.logEntries.shift();
    for (const listener of this.logListeners) listener({ ...entry });
  }
  async patchConfig(id: string, path: string, value: unknown, options?: BaasPatchOptions) {
    this.check(id);
    const parts = path
      .slice(1)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let cursor = this.configs[id];
    for (const part of parts.slice(0, -1)) {
      if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part]))
        throw new Error(`路径不存在：${path}`);
      cursor = cursor[part] as Record<string, unknown>;
    }
    if (
      options?.checkExpected &&
      JSON.stringify(cursor[parts.at(-1)!]) !== JSON.stringify(options.expectedValue)
    )
      throw new Error("配置在确认期间发生变化，请重新读取后再修改");
    cursor[parts.at(-1)!] = value;
    this.log(id, `演示配置已修改：${path}`);
    return { saved: true, path, value };
  }
  async request(command: string, profile?: string, payload: Record<string, unknown> = {}) {
    if (command === "detect_adb") return { addresses: ["127.0.0.1:5555 (demo)"] };
    if (command === "add_config") {
      if (
        typeof payload.name !== "string" ||
        !payload.name.trim() ||
        typeof payload.server !== "string" ||
        !payload.server.trim()
      )
        throw new Error("配置档名称和服务器不能为空");
      const serial = `demo-${randomUUID()}`;
      this.configs[serial] = demoConfiguration(payload.name, payload.server);
      this.state[serial] = {
        running: false,
        current_task: null,
        waiting_tasks: [],
        exit_code: null,
        run_id: null,
      };
      this.publish(serial);
      return { serial, demo: true };
    }
    if (!profile) throw new Error("需要选择配置档");
    this.check(profile);
    const state = this.state[profile];
    if (command === "stop_scheduler") {
      clearTimeout(this.timers.get(profile));
      this.timers.delete(profile);
      Object.assign(state, { running: false, current_task: null, exit_code: 0 });
      this.log(profile, "演示任务已停止");
      this.publish(profile);
      return { status: "stopped", config_id: profile, run_id: state.run_id, demo: true };
    }
    if (!["start_scheduler", "solve"].includes(command))
      throw new Error(`演示环境不支持：${command}`);
    if (state.running)
      return { status: "already-running", config_id: profile, run_id: state.run_id };
    const runId = randomUUID();
    Object.assign(state, {
      running: true,
      current_task: command === "solve" ? String(payload.task) : "scheduler",
      run_id: runId,
      exit_code: null,
    });
    this.log(profile, `演示开始：${state.current_task}`);
    this.publish(profile);
    if (command === "solve")
      this.timers.set(
        profile,
        setTimeout(() => {
          if (state.run_id !== runId) return;
          Object.assign(state, { running: false, current_task: null, exit_code: 0 });
          this.timers.delete(profile);
          this.log(profile!, "演示任务执行完成");
          this.publish(profile!);
        }, 700)
      );
    return { status: "started", config_id: profile, run_id: runId, demo: true };
  }
  private check(id: string) {
    if (!Object.hasOwn(this.configs, id)) throw new Error(`配置档不存在：${id}`);
  }
}
