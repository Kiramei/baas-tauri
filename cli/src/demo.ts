import { randomUUID } from "node:crypto";
import type {
  BaasLogEntry,
  BaasPatchOptions,
  BaasStatusSnapshot,
  BaasStatusUpdate,
} from "@baas/client";

/** Explicit process-local sandbox; no network, devices or real configuration are touched. */
export class DemoClient {
  private state: BaasStatusSnapshot = Object.fromEntries(
    ["sensei-cn", "sensei-jp"].map((id) => [
      id,
      { running: false, current_task: null, waiting_tasks: [], exit_code: null, run_id: null },
    ])
  );
  private configs: Record<string, Record<string, unknown>> = {
    "sensei-cn": {
      name: "夏莱 · 国服",
      server: "CN",
      screenshot_method: "adb",
      control_method: "adb",
    },
    "sensei-jp": {
      name: "夏莱 · 日服",
      server: "JP",
      screenshot_method: "adb",
      control_method: "adb",
    },
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
  async tasks(id: string) {
    this.check(id);
    return {
      collect_reward: { event_name: "收取奖励", enabled: true, next_tick: "每日重置" },
      cafe: { event_name: "咖啡厅", enabled: true, next_tick: "体力恢复后" },
      mail: { event_name: "邮件", enabled: true, next_tick: "每日重置" },
    };
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
      this.configs[serial] = {
        name: payload.name,
        server: payload.server,
        screenshot_method: "adb",
        control_method: "adb",
      };
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
