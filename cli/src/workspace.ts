import { BaasClient, type BaasLogEntry } from "@baas/client";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { RuntimeManager, type RuntimeEvent, type RuntimeUpdateCheck } from "./runtime";
import { reduceInstallationProgress, type InstallationProgress } from "./installation";
import { detectLanguage } from "./i18n";
import { DemoClient } from "./demo";
import {
  executeAction,
  prepareConfigurationChange,
  resolveProfile,
  validateAction,
  type ActionContext,
  type Client,
} from "./actions";
import { tokenize } from "./arguments";
import { loadPacks, type CommandPack, type PackCommand } from "./packs";
import { createRedactor, REDACTED, type Redactor } from "./redaction";
import {
  DEFAULT_URL,
  loadSettings,
  normalizeEndpoint,
  saveSettings,
  settingsDirectory,
  type Settings,
} from "./settings";
import { abortable } from "./monitor";
import { terminalText } from "./ui";
import manifest from "../package.json";
import {
  changedSchedulerFields,
  schedulerState,
  validateSchedulerChanges,
  validateNewEventState,
  type SchedulerChanges,
  type SchedulerState,
} from "./scheduler";
import type { BaasEventChange } from "@baas/client";

export interface WorkspaceOptions {
  demo?: boolean;
  readOnly?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  server?: string;
  pipe?: string;
  profile?: string;
  key?: string;
  serverKey?: string;
  timeout?: number;
  directory?: string;
  lang?: string;
}
export interface WorkspacePrompt {
  id?: string;
  kind: "secret" | "confirm" | "text";
  title: string;
  detail?: string;
  initial?: string;
}
export interface WorkspaceActivity {
  id: string;
  title: string;
  detail?: string;
  tone: "info" | "success" | "error";
}
export interface WorkspaceSnapshot {
  version: string;
  endpoint: string;
  demo: boolean;
  connected: boolean;
  connecting: boolean;
  profile?: string;
  profiles: Record<string, string>;
  tasks: Record<string, any>;
  status: Record<string, any>;
  logs: BaasLogEntry[];
  activity: WorkspaceActivity[];
  busy?: string;
  readOnly: boolean;
  dryRun: boolean;
  packs: { name: string; description: string }[];
  prompt?: WorkspacePrompt;
  language?: string;
  chooseLanguage?: boolean;
  setupNeeded?: boolean;
  installation?: InstallationProgress;
  update?: RuntimeUpdateCheck;
  scheduler?: SchedulerState;
  staticData?: Record<string, unknown>;
}

const MAX_LOGS = 300;
const MAX_ACTIVITY = 60;
// Wire values shared with Desktop's src/shared/serverOptions.ts (display labels are not CN/JP codes).
export const PROFILE_SERVERS = [
  "官服",
  "B服",
  "国际服",
  "国际服青少年",
  "韩国ONE",
  "日服",
  ...(process.platform === "win32" ? ["日服PC端", "Steam国际服"] : []),
];
const PROFILE_ACTIONS = new Set([
  "tasks",
  "config_get",
  "config_set",
  "scheduler_start",
  "scheduler_stop",
  "task_run",
  "wait_run",
]);
const HELP =
  "profiles · use <配置档> · tasks · run <任务> · start · stop · status · logs [数量] · devices · config get [/字段] · config set /字段 <JSON> · packs · pack <指令包命令> · connect [服务地址] · logout · doctor";

/** A deterministic BAAS automation workbench. No language model is created or called. */
export class Workspace {
  private readonly options: WorkspaceOptions;
  private readonly directory: string;
  private preferences: Settings = { url: DEFAULT_URL };
  private url = DEFAULT_URL;
  private pipe?: string;
  private key?: string;
  private redactor: Redactor;
  private secrets: string[] = [];
  private client?: Client;
  private localAttached = false;
  private scheduleRead = 0;
  private clientEpoch = 0;
  private offClient: (() => void)[] = [];
  private listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  private current?: AbortController;
  private promptWaiter?: { resolve(value: string | boolean): void; reject(error: Error): void };
  private packs: CommandPack[] = [];
  private lastRun?: { profile: string; run_id: string };
  private serial = 0;
  private promptSerial = 0;
  private announcedCompletion = new Set<string>();
  private legacyRuns = new Map<string, number>();
  private closed = false;
  private configurationError?: Error;
  private allLogs: BaasLogEntry[] = [];
  private liveLogRevision = 0;
  private liveLogs: { revision: number; entry: BaasLogEntry }[] = [];
  private state: WorkspaceSnapshot;
  private runtime: RuntimeManager;

  constructor(options: WorkspaceOptions = {}) {
    this.options = { ...options };
    this.directory = options.directory || settingsDirectory();
    this.runtime = new RuntimeManager({ directory: this.directory });
    this.key = options.key ?? process.env.BAAS_KEY;
    if (this.key) this.secrets.push(this.key);
    this.redactor = createRedactor(this.secrets);
    this.state = {
      version: manifest.version,
      endpoint: DEFAULT_URL,
      demo: !!options.demo,
      connected: false,
      connecting: false,
      profiles: {},
      tasks: {},
      status: {},
      logs: [],
      activity: [],
      readOnly: !!options.readOnly,
      dryRun: !!options.dryRun,
      packs: [],
    };
    this.configure(this.preferences);
    this.activity(
      "baax 工作台",
      options.demo
        ? "演示环境：操作仅作用于本进程的示例数据。"
        : "连接 BAAS 服务后选择配置档，查看任务并执行自动化。",
      "info"
    );
  }

  static async create(options: WorkspaceOptions = {}): Promise<Workspace> {
    const workspace = new Workspace(options);
    try {
      workspace.configure(await loadSettings(workspace.directory));
    } catch (error) {
      workspace.activity("无法读取工作台设置", errorText(error), "error");
    }
    try {
      workspace.packs = await loadPacks(
        workspace.preferences.packsDirectory || join(workspace.directory, "commands")
      );
      workspace.state.packs = workspace
        .commands()
        .map(({ name, description }) => ({ name, description }));
    } catch (error) {
      workspace.activity("无法加载指令包", errorText(error), "error");
    }
    workspace.publish();
    return workspace;
  }

  async initialize(): Promise<void> {
    if (this.state.connected) return;
    if (this.state.demo) {
      await this.connect();
      return;
    }
    if (this.state.chooseLanguage || this.state.setupNeeded) return;
    const explicitRemote = Boolean(
      this.options.server || this.options.pipe || process.env.BAAS_SERVER || process.env.BAAS_PIPE
    );
    if (this.preferences.connectionMode === "local" && !explicitRemote) await this.startLocal();
    else if (explicitRemote || this.preferences.connectionMode === "remote") await this.connect();
  }

  async setLanguage(language: string): Promise<void> {
    this.state.language = detectLanguage(language);
    this.state.chooseLanguage = false;
    this.preferences.language = this.state.language;
    if (!this.state.demo) await saveSettings(this.preferences, this.directory);
    this.publish();
    await this.initialize();
  }

  async setupRemote(): Promise<void> {
    await this.operation("连接已有服务", async (signal) => {
      const next = normalizeEndpoint(
        String(await this.ask({ kind: "text", title: "服务地址", initial: this.url }, signal))
      );
      this.disposeClient();
      this.pipe = undefined;
      this.url = next;
      this.configurationError = undefined;
      this.state.connected = false;
      this.state.endpoint = next;
      await this.ensureConnected(signal);
      await this.refreshData(signal);
      this.preferences = {
        ...this.preferences,
        url: next,
        pipe: undefined,
        connectionMode: "remote",
      };
      await saveSettings(this.preferences, this.directory);
      this.state.setupNeeded = false;
      this.activity("连接已建立", next, "success");
    });
  }

  async installLocal(channel: "stable" | "dev" = "dev"): Promise<void> {
    await this.operation("正在安装运行环境", async (signal) => {
      if (this.state.readOnly) throw new Error("当前为只读模式，不能安装运行环境");
      if (this.state.demo) throw new Error("演示环境不安装真实后端");
      const root = String(
        await this.ask(
          {
            kind: "text",
            title: "安装目录",
            initial: join(this.directory, "runtime"),
            detail: "自动安装 Python、后端与运行依赖",
          },
          signal
        )
      ).trim();
      if (!root) throw new Error("安装目录不能为空");
      if (this.state.dryRun) {
        this.activity("安装运行环境 · 预演", `${root}\n${channel}`, "info");
        return;
      }
      if (
        (await this.ask(
          {
            kind: "confirm",
            title: "开始安装",
            detail: `${root}\n${channel}\n自动安装 Python、后端与运行依赖`,
          },
          signal
        )) !== true
      )
        return;
      this.state.installation = undefined;
      await this.runtime.install({ root, channel }, (event) => this.runtimeEvent(event), signal);
      this.preferences.connectionMode = "local";
      this.preferences.pipe = undefined;
      await saveSettings(this.preferences, this.directory);
      this.state.setupNeeded = false;
      await this.attachLocal(signal, true);
      this.activity("安装完成", root, "success");
    });
  }

  async startLocal(): Promise<void> {
    await this.operation("启动本地后端", async (signal) => {
      await this.attachLocal(signal);
      this.preferences.connectionMode = "local";
      this.preferences.pipe = undefined;
      await saveSettings(this.preferences, this.directory);
      this.state.setupNeeded = false;
    });
  }

  private async attachLocal(signal: AbortSignal, preserveProgress = false): Promise<void> {
    this.disposeClient();
    this.state.connected = false;
    const { pipe } = await this.runtime.start((event) => this.runtimeEvent(event), signal);
    this.localAttached = true;
    this.pipe = pipe;
    this.state.endpoint = pipe;
    this.configurationError = undefined;
    await this.ensureConnected(signal);
    await this.refreshData(signal);
    if (!preserveProgress) this.state.installation = undefined;
    this.activity("连接已建立", "本地后端", "success");
  }

  private runtimeEvent(event: RuntimeEvent): void {
    this.state.installation = reduceInstallationProgress(this.state.installation, event);
    this.publish();
  }

  async checkUpdates(): Promise<void> {
    await this.operation("检查本地环境更新", async (signal) => {
      if (this.state.demo) throw new Error("演示环境不检查真实后端更新");
      this.state.installation = undefined;
      this.state.update = await this.runtime.checkUpdates(
        (event) => this.runtimeEvent(event),
        signal
      );
      this.activity(
        this.state.update.available ? "发现本地环境更新" : "本地环境已是最新",
        this.describe(this.state.update.repositories),
        "info"
      );
    });
  }

  async updateRuntime(): Promise<void> {
    await this.operation("更新本地环境", async (signal) => {
      if (this.state.readOnly) throw new Error("当前为只读模式，不能更新运行环境");
      if (this.state.demo) throw new Error("演示环境不更新真实后端");
      this.state.installation = undefined;
      const update = await this.runtime.checkUpdates((event) => this.runtimeEvent(event), signal);
      this.state.update = update;
      if (!update.available) {
        this.activity("本地环境已是最新", undefined, "success");
        return;
      }
      if (this.state.dryRun) {
        this.activity("更新本地环境 · 预演", this.describe(update.repositories), "info");
        return;
      }
      if (
        this.options.yes !== true &&
        (await this.ask(
          {
            kind: "confirm",
            title: "确认更新本地环境",
            detail: `${update.root}\n${this.describe(update.repositories)}\n仅在全部本地任务空闲时更新。`,
          },
          signal
        )) !== true
      ) {
        this.activity("已取消更新本地环境", undefined, "info");
        return;
      }
      signal.throwIfAborted();
      const reconnectLocal = this.localAttached;
      await this.runtime.stopWhenIdle(signal);
      if (reconnectLocal) {
        this.disposeClient();
        this.state.connected = false;
      }
      await this.runtime.update((event) => this.runtimeEvent(event), signal);
      if (reconnectLocal) await this.attachLocal(signal, true);
      this.state.update = undefined;
      this.activity("本地环境更新完成", update.root, "success");
    });
  }

  get snapshot(): WorkspaceSnapshot {
    return structuredClone(this.state);
  }

  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): () => void {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    try {
      listener(this.snapshot);
    } catch {
      /* Observers cannot break initialization. */
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  answerPrompt(value: string | boolean | null): void {
    const waiter = this.promptWaiter,
      prompt = this.state.prompt;
    if (!waiter || !prompt) return;
    if (value === null) {
      this.cancel();
      return;
    }
    if (prompt.kind !== "confirm" && typeof value !== "string") {
      this.activity("请输入文本", "当前输入不是确认选项。", "error");
      return;
    }
    if (prompt.kind === "secret" && typeof value === "string" && !value.trim()) {
      this.activity("登录 Key 不能为空", undefined, "error");
      return;
    }
    this.promptWaiter = undefined;
    this.state.prompt = undefined;
    waiter.resolve(
      prompt.kind === "confirm"
        ? value === true ||
            (typeof value === "string" && /^(?:y|yes|true|确认|是)$/i.test(value.trim()))
        : value
    );
    this.publish();
  }

  async connect(): Promise<void> {
    await this.operation("连接服务", async (signal) => {
      await this.ensureConnected(signal);
      await this.refreshData(signal);
      this.activity("连接已建立", this.state.endpoint, "success");
    });
  }

  async selectProfile(id: string): Promise<void> {
    await this.operation("选择配置档", async (signal) => {
      const client = await this.ensureConnected(signal);
      const selected = await abortable(resolveProfile(client, id), signal);
      signal.throwIfAborted();
      this.state.profile = selected;
      this.lastRun = undefined;
      this.preferences.profile = selected;
      await this.refreshData(signal);
      if (!this.state.demo) await abortable(saveSettings(this.preferences, this.directory), signal);
      this.activity(
        "已选择配置档",
        `${this.state.profiles[selected] || selected} · ${selected}`,
        "success"
      );
    });
  }

  /** Create the first real profile without requiring an existing profile selection. */
  async addProfile(): Promise<void> {
    await this.operation("新建配置档", async (signal) => {
      if (this.state.readOnly) throw new Error("当前为只读模式，不能新建配置档");
      await this.ensureConnected(signal);
      const name = String(
        await this.ask(
          { kind: "text", title: "配置档名称", detail: "请输入便于识别的名称（最多 80 个字符）。" },
          signal
        )
      ).trim();
      const server = String(
        await this.ask(
          {
            kind: "text",
            title: "选择服务器",
            initial: "官服",
            detail: `可用服务器：${PROFILE_SERVERS.join("、")}。请输入完整名称。`,
          },
          signal
        )
      ).trim();
      await this.createProfileInOperation(name, server, signal);
    });
  }

  async createProfile(name: string, server: string): Promise<void> {
    await this.operation("新建配置档", (signal) =>
      this.createProfileInOperation(name, server, signal)
    );
  }

  private async createProfileInOperation(
    name: string,
    server: string,
    signal: AbortSignal
  ): Promise<void> {
    if (this.state.readOnly) throw new Error("当前为只读模式，不能新建配置档");
    name = name.trim();
    server = server.trim();
    if (!name || name.length > 80 || terminalText(name) !== name || name.includes("\n"))
      throw new Error("配置档名称需要 1–80 个字符，且不能包含终端控制字符或换行");
    if (!PROFILE_SERVERS.includes(server))
      throw new Error(`服务器无效，可用值：${PROFILE_SERVERS.join("、")}`);
    const client = await this.ensureConnected(signal);
    const available = await abortable(client.profiles(), signal);
    if (Object.values(available).some((existing) => existing.trim() === name))
      throw new Error("已存在同名配置档，请使用其他名称");
    const detail = this.describe({ name, server });
    if (this.state.dryRun) {
      this.activity("新建配置档 · 预演", detail, "info");
      return;
    }
    if (
      !this.options.yes &&
      (await this.ask({ kind: "confirm", title: "确认新建配置档", detail }, signal)) !== true
    ) {
      this.activity("已取消新建配置档", "未提交到后端。", "info");
      return;
    }
    signal.throwIfAborted();
    const current = await abortable(client.profiles(), signal);
    if (Object.values(current).some((existing) => existing.trim() === name))
      throw new Error("确认期间出现同名配置档，未提交新建操作");
    const result = await abortable(
      client.request("add_config", undefined, { name, server }),
      signal
    );
    signal.throwIfAborted();
    if (
      !result ||
      typeof result.serial !== "string" ||
      !result.serial ||
      result.serial.length > 256
    )
      throw new Error("新建响应缺少配置档 ID，请刷新配置档列表确认结果，避免重复提交");
    this.state.profile = result.serial;
    this.preferences.profile = result.serial;
    this.lastRun = undefined;
    await this.refreshData(signal);
    if (this.state.profile !== result.serial || !Object.hasOwn(this.state.profiles, result.serial))
      throw new Error("配置档已提交创建，但尚未载入列表，请刷新查看，避免重复提交");
    if (!this.state.demo) await abortable(saveSettings(this.preferences, this.directory), signal);
    this.activity("配置档已创建", `${name} · ${server}`, "success");
  }

  async run(task: string): Promise<void> {
    await this.action("运行任务", "task_run", { task });
  }
  async start(): Promise<void> {
    await this.action("启动调度", "scheduler_start");
  }
  async stop(): Promise<void> {
    await this.action("停止调度", "scheduler_stop");
  }
  async refresh(): Promise<void> {
    await this.operation("刷新工作台", async (signal) => {
      await this.refreshData(signal);
      this.activity(
        "工作台已刷新",
        `${Object.keys(this.state.profiles).length} 个配置档 · ${Object.keys(this.state.tasks).length} 项任务`,
        "success"
      );
    });
  }

  async getConfig(): Promise<Record<string, any>> {
    return (
      (await this.operation("读取配置", async (signal) => {
        const context = this.context(signal);
        const result = await abortable(executeAction("config_get", {}, context), signal);
        const client = (await this.ensureConnected(signal)) as Client &
          Pick<BaasClient, "staticData">;
        try {
          this.state.staticData = await abortable(client.staticData(), signal);
        } catch (error) {
          signal.throwIfAborted();
          this.state.staticData = {};
          this.activity("配置选项数据不可用", errorText(error), "info");
        }
        this.publish();
        return this.redactor.result("config_get", {}, result) as Record<string, any>;
      })) ?? {}
    );
  }

  async setConfig(path: string, value: unknown): Promise<boolean> {
    return (
      (await this.operation("修改配置", async (signal) => {
        await this.showAction("修改配置", "config_set", { path, value }, signal);
        return true;
      })) ?? false
    );
  }

  async loadScheduler(): Promise<SchedulerState | undefined> {
    return this.operation("读取调度", (signal) => this.readScheduler(signal));
  }

  async saveScheduler(taskId: string, fields: SchedulerChanges): Promise<boolean> {
    return this.changeScheduler("修改任务调度", (tasks) => [
      { taskId, fields: validateSchedulerChanges(taskId, fields, tasks) },
    ]);
  }

  async setAllSchedulerEnabled(enabled: boolean): Promise<boolean> {
    return this.changeScheduler(enabled ? "启用全部调度" : "禁用全部调度", (tasks) =>
      tasks.map((task) => ({ taskId: task.func_name, fields: { enabled } }))
    );
  }

  async resetSchedulerTimes(): Promise<boolean> {
    const next_tick = Math.floor(Date.now() / 1000);
    return this.changeScheduler("重置全部执行时间", (tasks) =>
      tasks.map((task) => ({ taskId: task.func_name, fields: { next_tick } }))
    );
  }

  async setNewEventState(value: string): Promise<boolean> {
    return (
      (await this.operation("修改新增任务默认状态", async (signal) => {
        const next = validateNewEventState(value);
        await abortable(
          executeAction(
            "config_set",
            { path: "/new_event_enable_state", value: next },
            this.context(signal)
          ),
          signal
        );
        await this.readScheduler(signal);
        this.activity(
          this.state.dryRun ? "新增任务默认状态 · 预演" : "新增任务默认状态已保存",
          next,
          this.state.dryRun ? "info" : "success"
        );
        return true;
      })) ?? false
    );
  }

  private async readScheduler(signal: AbortSignal): Promise<SchedulerState> {
    const client = (await this.ensureConnected(signal)) as Client &
      Pick<BaasClient, "events" | "patchEvents">;
    const profile = await abortable(resolveProfile(client, this.state.profile), signal);
    const [tasks, config] = await abortable(
      Promise.all([client.events(profile), client.config(profile)]),
      signal
    );
    signal.throwIfAborted();
    const next = schedulerState(profile, tasks, config.new_event_enable_state ?? "default");
    this.state.scheduler = next;
    this.state.tasks = Object.fromEntries(
      next.tasks.map((task) => [task.func_name, structuredClone(task)])
    );
    this.publish();
    return structuredClone(next);
  }

  private async changeScheduler(
    title: string,
    plan: (tasks: SchedulerState["tasks"]) => { taskId: string; fields: SchedulerChanges }[]
  ): Promise<boolean> {
    return (
      (await this.operation(title, async (signal) => {
        if (this.state.readOnly) throw new Error("当前为只读模式，不能修改调度");
        const active = this.state.scheduler;
        const baseline =
          active && active.profile === this.state.profile
            ? structuredClone(active)
            : await this.readScheduler(signal);
        const changes: BaasEventChange[] = plan(baseline.tasks)
          .map(({ taskId, fields }) => {
            const task = baseline.tasks.find((item) => item.func_name === taskId)!;
            const changed = changedSchedulerFields(
              task,
              validateSchedulerChanges(taskId, fields, baseline.tasks)
            );
            return {
              func_name: taskId,
              fields: changed,
              expected: Object.fromEntries(
                Object.keys(changed).map((key) => [key, structuredClone(task[key])])
              ),
            };
          })
          .filter((change) => Object.keys(change.fields).length > 0);
        if (!changes.length) {
          this.activity("调度没有变化", undefined, "info");
          return true;
        }
        const detail = this.describe(
          changes.map(({ func_name, fields }) => ({ task: func_name, ...fields }))
        );
        if (this.state.dryRun) {
          this.activity(`${title} · 预演`, detail, "info");
          return true;
        }
        if (
          this.options.yes !== true &&
          (await this.ask({ kind: "confirm", title: "确认修改调度", detail }, signal)) !== true
        ) {
          this.activity("已取消修改调度", "未提交到后端。", "info");
          return false;
        }
        signal.throwIfAborted();
        const client = (await this.ensureConnected(signal)) as Client &
          Pick<BaasClient, "events" | "patchEvents">;
        await abortable(client.patchEvents(baseline.profile, changes), signal);
        await this.readScheduler(signal);
        this.activity("调度已保存", detail, "success");
        return true;
      })) ?? false
    );
  }

  /** Execute explicit commands only; arbitrary prose is never sent to a model. */
  async execute(line: string): Promise<void> {
    let tokens: string[];
    try {
      tokens = tokenize(line.trim().replace(/^\//, ""));
    } catch (error) {
      this.activity("命令格式有误", errorText(error), "error");
      return;
    }
    const [command, ...args] = tokens;
    if (!command) return;
    if (command === "update" || command === "check-update") {
      if (args.length) {
        this.activity("命令格式有误", "用法：update 或 check-update", "error");
        return;
      }
      if (command === "update") await this.updateRuntime();
      else await this.checkUpdates();
      return;
    }
    if (command === "new-profile" && !args.length) {
      await this.addProfile();
      return;
    }
    if (command === "profile") {
      if (args[0] === "create" && args.length === 3) await this.createProfile(args[1], args[2]);
      else
        this.activity(
          "命令格式有误",
          '用法：profile create "配置档名称" "服务器"；交互创建请使用 new-profile',
          "error"
        );
      return;
    }
    if (command === "install" && args.length <= 1) {
      if (args[0] && !["stable", "dev"].includes(args[0])) {
        this.activity("未知安装通道", args[0], "error");
        return;
      }
      await this.installLocal(args[0] as "stable" | "dev" | undefined);
      return;
    }
    if (command === "local" && !args.length) {
      await this.startLocal();
      return;
    }
    const count = (minimum: number, maximum = minimum) => {
      if (args.length < minimum || args.length > maximum)
        throw new Error(
          `命令 ${command} 需要 ${minimum === maximum ? minimum : `${minimum}–${maximum}`} 个参数；使用 help 查看用法。`
        );
    };
    if (command === "logout") {
      if (args.length) {
        this.activity("命令格式有误", "logout 不接受参数", "error");
        return;
      }
      this.cancel();
      this.disposeClient();
      this.key = undefined;
      this.lastRun = undefined;
      this.state.connected = false;
      this.state.connecting = false;
      this.state.profiles = {};
      this.state.tasks = {};
      this.state.status = {};
      this.allLogs = [];
      this.state.logs = [];
      this.activity("已退出连接", "登录 Key 已从当前工作台清除。", "info");
      return;
    }
    if (command === "help") {
      this.activity("工作台命令", HELP, "info");
      return;
    }
    if (command === "connect" && args.length === 0) {
      await this.connect();
      return;
    }
    if (command === "use" && args.length === 1) {
      await this.selectProfile(args[0]);
      return;
    }
    if (command === "run" && args.length === 1) {
      await this.run(args[0]);
      return;
    }
    if (command === "start" && args.length === 0) {
      await this.start();
      return;
    }
    if (command === "stop" && args.length === 0) {
      await this.stop();
      return;
    }
    await this.operation(`/${command}`, async (signal) => {
      switch (command) {
        case "connect": {
          count(1);
          const next = normalizeEndpoint(args[0]);
          this.disposeClient();
          this.url = next;
          this.pipe = undefined;
          this.preferences = {
            ...this.preferences,
            url: next,
            pipe: undefined,
            connectionMode: "remote",
          };
          this.state.endpoint = this.state.demo ? "演示环境 · 本地沙盒" : next;
          this.configurationError = undefined;
          this.state.connected = false;
          await this.ensureConnected(signal);
          await this.refreshData(signal);
          if (!this.state.demo)
            await abortable(saveSettings(this.preferences, this.directory), signal);
          this.state.setupNeeded = false;
          this.activity("连接已建立", this.state.endpoint, "success");
          break;
        }
        case "use":
          count(1);
          throw new Error("请选择有效配置档");
        case "run":
          count(1);
          break;
        case "start":
        case "stop":
          count(0);
          break;
        case "status":
          count(0);
          await this.showAction("运行状态", "status", {}, signal);
          break;
        case "profiles":
          count(0);
          await this.showAction("配置档", "profiles", {}, signal);
          break;
        case "tasks":
          count(0);
          await this.showAction("任务安排", "tasks", {}, signal);
          break;
        case "devices":
          count(0);
          await this.showAction("设备列表", "devices", {}, signal);
          break;
        case "logs": {
          count(0, 1);
          const limit = args[0] === undefined ? 100 : Number(args[0]);
          await this.showAction("运行日志", "logs", { limit }, signal);
          break;
        }
        case "config": {
          if (args[0] === "get" && args.length <= 2) {
            await this.showAction("配置内容", "config_get", { path: args[1] || "" }, signal);
          } else if (args[0] === "set" && args.length >= 3) {
            let value: unknown;
            try {
              value = JSON.parse(args.slice(2).join(" "));
            } catch {
              throw new Error("配置值必须是有效 JSON，例如 true、123 或 '\"新名称\"'");
            }
            await this.showAction("修改配置", "config_set", { path: args[1], value }, signal);
          } else throw new Error("用法：config get [/字段] 或 config set /字段 <JSON>");
          break;
        }
        case "packs":
          count(0);
          this.activity("指令包命令", this.describe(this.state.packs), "info");
          break;
        case "pack":
          count(1);
          await this.executePack(args[0], signal);
          break;
        case "doctor":
          count(0);
          await this.refreshData(signal);
          this.activity(
            "服务检查通过",
            this.describe({
              endpoint: this.state.endpoint,
              transport: this.state.demo ? "demo" : this.pipe ? "pipe" : "encrypted-websocket",
              connected: this.state.connected,
              profiles: Object.keys(this.state.profiles).length,
            }),
            "success"
          );
          break;
        default:
          if (this.commands().some((item) => item.name === command)) {
            count(0);
            await this.executePack(command, signal);
          } else throw new Error(`未知指令：${command}。请使用 help 查看 BAAS 自动化命令。`);
      }
    });
  }

  cancel(): void {
    const error = new DOMException("操作已取消", "AbortError");
    this.current?.abort(error);
    const waiter = this.promptWaiter;
    this.promptWaiter = undefined;
    this.state.prompt = undefined;
    waiter?.reject(error);
    if (this.state.connecting) {
      this.disposeClient();
      this.state.connected = false;
      this.state.connecting = false;
    }
    this.publish();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    this.disposeClient();
    this.runtime.close();
    this.listeners.clear();
  }

  private configure(settings: Settings): void {
    this.preferences = { ...settings };
    this.state.language = detectLanguage(this.options.lang, settings.language);
    this.state.chooseLanguage =
      !this.state.demo && !this.options.lang && !process.env.BAAS_LANG && !settings.language;
    this.state.setupNeeded =
      !this.state.demo &&
      !this.options.server &&
      !this.options.pipe &&
      !process.env.BAAS_SERVER &&
      !process.env.BAAS_PIPE &&
      !settings.pipe &&
      !settings.connectionMode &&
      !existsSync(join(this.directory, "runtime.json")) &&
      settings.url === DEFAULT_URL;
    if (!settings.connectionMode) {
      if (settings.pipe || (settings.url && settings.url !== DEFAULT_URL))
        this.preferences.connectionMode = "remote";
      else if (existsSync(join(this.directory, "runtime.json")))
        this.preferences.connectionMode = "local";
    }
    try {
      if (this.options.server && this.options.pipe)
        throw new Error("服务地址和本地管道只能选择一种连接方式");
      if (
        this.options.timeout !== undefined &&
        (!Number.isFinite(this.options.timeout) || this.options.timeout <= 0)
      )
        throw new Error("连接超时必须是正数");
      const server = this.options.server || process.env.BAAS_SERVER;
      this.url = normalizeEndpoint(server || settings.url || DEFAULT_URL);
      this.pipe =
        this.options.pipe || (server ? undefined : process.env.BAAS_PIPE || settings.pipe);
      this.state.endpoint = this.state.demo ? "演示环境 · 本地沙盒" : this.pipe || this.url;
      this.state.profile =
        this.options.profile ||
        (this.state.demo ? "sensei-cn" : process.env.BAAS_PROFILE || settings.profile);
      this.configurationError = undefined;
    } catch (error) {
      this.configurationError = error instanceof Error ? error : new Error(String(error));
      this.activity("连接设置有误", errorText(error), "error");
    }
  }

  private async operation<T>(
    title: string,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T | undefined> {
    if (this.closed) return undefined;
    if (this.current) {
      this.activity("已有操作正在进行", "请等待当前操作完成，或先取消当前操作。", "info");
      return undefined;
    }
    const controller = new AbortController();
    this.current = controller;
    this.state.busy = title;
    this.publish();
    try {
      return await work(controller.signal);
    } catch (error) {
      const cancelled =
        controller.signal.aborted ||
        (error as Error)?.name === "AbortError" ||
        errorText(error).includes("操作已取消");
      if (
        this.state.installation &&
        ["正在安装运行环境", "启动本地后端", "更新本地环境", "检查本地环境更新"].includes(title)
      ) {
        this.runtimeEvent({
          type: "progress",
          stage: cancelled ? "cancelled" : "error",
          status: "failed",
          message: errorText(error),
        });
      }
      this.activity(
        cancelled ? "操作已取消" : `${title}失败`,
        cancelled ? "未提交的新操作已取消；已经提交的后端任务会继续运行。" : errorText(error),
        cancelled ? "info" : "error"
      );
      return undefined;
    } finally {
      if (this.current === controller) {
        this.current = undefined;
        this.state.busy = undefined;
      }
      this.publish();
    }
  }

  private async ensureConnected(signal: AbortSignal): Promise<Client> {
    signal.throwIfAborted();
    if (this.configurationError) throw this.configurationError;
    if (this.state.connected && this.client) return this.client;
    this.state.connecting = true;
    this.publish();
    const onAbort = () => {
      this.disposeClient();
      this.state.connected = false;
      this.state.connecting = false;
      this.publish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (!this.state.demo && !this.pipe && !this.key) {
        const key = await this.ask(
          { kind: "secret", title: "BAAS 登录 Key", detail: "仅用于当前连接，不写入设置文件。" },
          signal
        );
        signal.throwIfAborted();
        this.key = String(key);
        this.secrets.push(this.key);
        this.redactor = createRedactor(this.secrets);
      }
      if (!this.client) {
        const client = this.state.demo
          ? new DemoClient()
          : new BaasClient({
              ...(this.pipe ? { pipe: this.pipe } : { url: this.url }),
              key: this.key,
              serverSignPublicKey:
                this.options.serverKey || process.env.BAAS_SERVER_SIGN_PUBLIC_KEY,
              timeoutMs: this.options.timeout,
            });
        this.client = client;
        const epoch = ++this.clientEpoch;
        const current = () => !this.closed && this.client === client && epoch === this.clientEpoch;
        this.offClient = [
          client.onLog((entry) => {
            if (!current()) return;
            const safe = this.redactor.value(entry) as BaasLogEntry;
            this.allLogs.push(safe);
            if (this.allLogs.length > MAX_LOGS) this.allLogs.shift();
            this.liveLogs.push({ revision: ++this.liveLogRevision, entry: safe });
            if (this.liveLogs.length > MAX_LOGS) this.liveLogs.shift();
            this.updateVisibleLogs();
            this.publish();
          }),
          client.onStatus((_update, snapshot) => {
            if (!current()) return;
            const profile = this.state.profile,
              before = profile ? this.state.status[profile] : undefined,
              after = profile ? snapshot[profile] : undefined;
            this.recordStatus(snapshot);
            this.publish();
            if (
              profile &&
              before?.running === true &&
              after &&
              (after.running === false || after.current_task !== before.current_task)
            ) {
              const read = ++this.scheduleRead;
              void client
                .tasks(profile)
                .then((tasks) => {
                  if (!current() || read !== this.scheduleRead || profile !== this.state.profile)
                    return;
                  this.state.tasks = this.redactor.value(tasks) as Record<string, any>;
                  this.state.scheduler = schedulerState(
                    profile,
                    this.state.tasks,
                    this.state.scheduler?.profile === profile
                      ? this.state.scheduler.newEventState
                      : "default"
                  );
                  this.publish();
                })
                .catch(() => {
                  // Status/log streaming stays usable if a read-only refresh fails.
                });
            }
          }),
          client.onDisconnect((error) => {
            if (!current()) return;
            this.state.connected = false;
            this.activity("服务连接已断开", error.message, "error");
          }),
        ];
      }
      const client = this.client;
      await abortable(client.connect(), signal);
      signal.throwIfAborted();
      this.state.connected = true;
      return client;
    } catch (error) {
      if (!signal.aborted) this.state.connected = false;
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.state.connecting = false;
      this.publish();
    }
  }

  private async refreshData(signal: AbortSignal): Promise<void> {
    const client = await this.ensureConnected(signal);
    const [profiles, status] = await abortable(
      Promise.all([client.profiles(), client.status()]),
      signal
    );
    signal.throwIfAborted();
    this.state.profiles = this.redactor.value(profiles) as Record<string, string>;
    this.recordStatus(status);
    if (this.state.profile && !Object.hasOwn(profiles, this.state.profile)) {
      const matches = Object.entries(profiles).filter(([, name]) => name === this.state.profile);
      if (matches.length === 1) this.state.profile = matches[0][0];
      else {
        this.activity("请选择配置档", `配置档 ${this.state.profile} 不存在或名称不唯一。`, "info");
        this.state.profile = undefined;
      }
    }
    this.state.tasks = this.state.profile
      ? (this.redactor.value(await abortable(client.tasks(this.state.profile), signal)) as Record<
          string,
          any
        >)
      : {};
    this.state.scheduler = this.state.profile
      ? schedulerState(
          this.state.profile,
          this.state.tasks,
          this.state.scheduler?.profile === this.state.profile
            ? this.state.scheduler.newEventState
            : "default"
        )
      : undefined;
    const revision = this.liveLogRevision;
    const history = await abortable(client.logs(MAX_LOGS), signal);
    const known = new Map<string, number>();
    const next = history.map((entry) => this.redactor.value(entry) as BaasLogEntry);
    for (const entry of next) known.set(logKey(entry), (known.get(logKey(entry)) || 0) + 1);
    for (const { entry } of this.liveLogs.filter((item) => item.revision > revision)) {
      const key = logKey(entry),
        count = known.get(key) || 0;
      if (count) known.set(key, count - 1);
      else next.push(entry);
    }
    this.allLogs = next.slice(-MAX_LOGS);
    this.updateVisibleLogs();
    this.publish();
  }

  private context(signal: AbortSignal): ActionContext {
    return {
      client: (requestedSignal) => this.ensureConnected(requestedSignal || signal),
      profile: this.state.profile,
      readOnly: this.state.readOnly,
      dryRun: this.state.dryRun,
      signal,
      lastRun: this.lastRun,
      approvalBaselines: new Map(),
      language: this.state.language,
      approve: async (name, args) =>
        this.options.yes === true ||
        (await this.ask(
          {
            kind: "confirm",
            title: "确认提交 BAAS 操作",
            detail: this.describe(this.redactor.arguments(name, { action: name, ...args })),
          },
          signal
        )) === true,
    };
  }

  private async action(
    title: string,
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<void> {
    await this.operation(title, (signal) => this.showAction(title, name, args, signal));
  }

  private async showAction(
    title: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    if (name === "config_set") this.rejectHiddenValue(args.value);
    const context = this.context(signal);
    const result = await abortable(executeAction(name, args, context), signal);
    signal.throwIfAborted();
    this.lastRun = context.lastRun;
    this.presentAction(title, name, args, result);
    const state = result as Record<string, unknown> | undefined;
    if (
      ["task_run", "scheduler_start", "scheduler_stop", "config_set"].includes(name) &&
      !state?.dry_run
    )
      await this.refreshData(signal);
    return result;
  }

  private async executePack(name: string, signal: AbortSignal): Promise<void> {
    const command = this.commands().find((item) => item.name === name);
    if (!command) throw new Error(`指令包命令不存在：${name}；使用 packs 查看`);
    const context = this.context(signal);
    for (const step of command.steps) {
      const definition = validateAction(step.action, step.args);
      if (step.action === "config_set") this.rejectHiddenValue(step.args.value);
      if (definition.mutating && this.state.readOnly)
        throw new Error("当前为只读模式，指令包包含状态修改，未执行任何步骤");
      if (PROFILE_ACTIONS.has(step.action)) {
        const client = await this.ensureConnected(signal);
        const profile = await abortable(
          resolveProfile(client, String(step.args.profile ?? this.state.profile ?? "")),
          signal
        );
        if (
          step.action === "task_run" &&
          !Object.hasOwn(await abortable(client.tasks(profile), signal), String(step.args.task))
        )
          throw new Error(`指令包任务不存在：${step.args.task}；未执行任何步骤`);
        if (step.action === "config_set")
          await abortable(
            prepareConfigurationChange(
              client,
              profile,
              String(step.args.path),
              step.args.value,
              this.state.language
            ),
            signal
          );
      }
    }
    if (this.state.dryRun) {
      this.activity(`${name} · 预演`, this.describe({ steps: command.steps }), "info");
      return;
    }
    this.activity(`执行指令包 /${name}`, command.description, "info");
    for (const step of command.steps) {
      signal.throwIfAborted();
      context.profile = this.state.profile;
      context.lastRun = this.lastRun;
      const result = await abortable(executeAction(step.action, step.args, context), signal);
      this.lastRun = context.lastRun;
      const state = result as Record<string, unknown> | undefined;
      this.presentAction(`${name} → ${step.action}`, step.action, step.args, result);
      if (state?.accepted === false) throw new Error("已有任务正在运行；指令包没有重复启动任务");
      if (state?.completed && state.succeeded === false) break;
    }
    await this.refreshData(signal);
  }

  private ask(prompt: WorkspacePrompt, signal: AbortSignal): Promise<string | boolean> {
    signal.throwIfAborted();
    if (this.promptWaiter) return Promise.reject(new Error("已有输入等待处理"));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        if (this.promptWaiter === waiter) {
          this.promptWaiter = undefined;
          this.state.prompt = undefined;
          this.publish();
        }
      };
      const waiter = {
        resolve: (value: string | boolean) => {
          cleanup();
          resolve(value);
        },
        reject: (error: Error) => {
          cleanup();
          reject(error);
        },
      };
      const onAbort = () =>
        waiter.reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("操作已取消", "AbortError")
        );
      this.promptWaiter = waiter;
      this.state.prompt = { ...structuredClone(prompt), id: `prompt-${++this.promptSerial}` };
      signal.addEventListener("abort", onAbort, { once: true });
      this.publish();
    });
  }

  private recordStatus(snapshot: Record<string, any>): void {
    const safe = this.redactor.value(snapshot) as Record<string, any>;
    const previous = this.state.status;
    this.state.status = safe;
    for (const [id, status] of Object.entries(safe)) {
      if (!status || typeof status !== "object") continue;
      const before = previous[id];
      const task = this.taskLabel(
        id,
        status.current_task ||
          before?.current_task ||
          (status.run_mode === "scheduler" ? "scheduler" : undefined)
      );
      if (status.running === true && (!before?.running || before?.run_id !== status.run_id)) {
        if (!status.run_id) this.legacyRuns.set(id, (this.legacyRuns.get(id) || 0) + 1);
        this.activity(
          before ? "任务已开始" : "检测到正在运行",
          `${this.profileLabel(id)} · ${task}`,
          "info"
        );
      }
      const identity = `${id}:${status.run_id || `legacy-${this.legacyRuns.get(id) || 0}`}`;
      if (
        before?.running === true &&
        status.running === false &&
        (!before.run_id || before.run_id === status.run_id) &&
        typeof status.exit_code === "number" &&
        !this.announcedCompletion.has(identity)
      ) {
        this.announcedCompletion.add(identity);
        if (this.announcedCompletion.size > 300)
          this.announcedCompletion.delete(this.announcedCompletion.values().next().value!);
        this.activity(
          status.exit_code === 0 ? `任务 ${task} · 已完成` : `任务 ${task} · 执行失败`,
          `${this.profileLabel(id)} · ${status.exit_code === 0 ? "正常结束" : `退出码 ${status.exit_code}`}`,
          status.exit_code === 0 ? "success" : "error"
        );
      }
    }
  }

  private presentAction(
    title: string,
    name: string,
    args: Record<string, unknown>,
    result: unknown
  ): void {
    const state = result && typeof result === "object" ? (result as Record<string, any>) : {};
    const profile = this.profileLabel(String(args.profile || this.state.profile || ""));
    if (name === "profiles")
      this.state.profiles = this.redactor.value(result) as Record<string, string>;
    if (name === "status") this.recordStatus(state);
    if (name === "tasks") this.state.tasks = this.redactor.value(result) as Record<string, any>;
    if (name === "logs") {
      this.allLogs = (result as BaasLogEntry[]).map(
        (entry) => this.redactor.value(entry) as BaasLogEntry
      );
      this.updateVisibleLogs();
    }
    if (state.dry_run) {
      const detail =
        name === "config_set"
          ? `${profile} · ${String(args.path)}：${this.describe(this.redactor.result(name, args, state.before))} → ${this.describe(this.redactor.result(name, args, args.value))}`
          : `${profile} · 仅预览，未提交后端操作`;
      this.activity(`${title} · 预演`, detail, "info");
      return;
    }
    if (state.accepted === false) {
      this.activity("已有任务正在运行", `${profile} · 本次未重复提交`, "info");
      return;
    }
    if (state.completed === true) {
      this.activity(
        state.succeeded === false ? "运行已结束 · 失败" : "运行已结束",
        `${profile} · ${state.succeeded === false ? "请查看运行日志" : "已确认本轮运行结束"}`,
        state.succeeded === false ? "error" : "success"
      );
      return;
    }
    if (name === "task_run") {
      this.activity(
        `运行任务 ${this.taskLabel(this.state.profile || "", String(args.task))} · 已提交`,
        `${profile} · 后台正在执行，运行状态会实时更新`,
        "success"
      );
      return;
    }
    if (name === "scheduler_start") {
      this.activity("启动调度 · 已提交", `${profile} · 后台调度正在运行`, "success");
      return;
    }
    if (name === "scheduler_stop") {
      this.activity(
        state.status === "stopping" ? "已请求停止调度" : "调度已停止",
        `${profile}${state.status === "stopping" ? " · 正在等待当前任务退出" : ""}`,
        state.status === "stopping" ? "info" : "success"
      );
      return;
    }
    if (name === "config_set") {
      this.activity("配置已保存", `${profile} · ${String(args.path)} 已更新`, "success");
      return;
    }
    if (name === "profiles") {
      this.activity(
        title,
        Object.entries(this.state.profiles)
          .map(([id, label]) => `${label} · ${id}`)
          .join("\n"),
        "info"
      );
      return;
    }
    if (name === "status") {
      this.activity(
        title,
        Object.entries(state)
          .map(
            ([id, status]) =>
              `${this.profileLabel(id)} · ${status?.running ? "运行中" : "空闲"}${status?.current_task ? ` · ${this.taskLabel(id, status.current_task)}` : ""}`
          )
          .join("\n") || "暂无运行状态",
        "info"
      );
      return;
    }
    if (name === "tasks") {
      this.activity(
        title,
        Object.entries(state)
          .map(
            ([id, task]) =>
              `${this.taskLabel(this.state.profile || "", id)} · ${task?.enabled === false ? "已停用" : "已启用"}`
          )
          .join("\n") || "此配置档暂无任务",
        "info"
      );
      return;
    }
    if (name === "logs") {
      this.activity(title, `已载入 ${(result as BaasLogEntry[]).length} 条运行日志`, "info");
      return;
    }
    if (name === "devices") {
      this.activity(
        title,
        Array.isArray(state.addresses)
          ? state.addresses.join("\n") || "未发现可连接设备"
          : "设备检查完成",
        "info"
      );
      return;
    }
    this.activity(title, this.describe(this.redactor.result(name, args, result)), "success");
  }

  private rejectHiddenValue(value: unknown): void {
    const contains = (item: unknown): boolean =>
      typeof item === "string"
        ? item.includes(REDACTED)
        : item !== null && typeof item === "object"
          ? Object.values(item).some(contains)
          : false;
    if (contains(value))
      throw new Error(
        "脱敏占位符不是实际配置值；请输入明确的新值，或使用空字符串清除。未覆盖当前配置。"
      );
  }
  private profileLabel(id: string): string {
    return this.state.profiles[id] || id || "当前配置档";
  }
  private taskLabel(profile: string, id?: string): string {
    if (!id || id === "scheduler") return "调度";
    const task = profile === this.state.profile ? this.state.tasks[id] : undefined;
    return String(task?.event_name || task?.display_name || task?.name || id);
  }

  private commands(): PackCommand[] {
    return this.packs.flatMap((pack) => pack.commands);
  }
  private disposeClient(): void {
    this.localAttached = false;
    this.scheduleRead++;
    this.state.staticData = undefined;
    this.state.scheduler = undefined;
    this.clientEpoch++;
    for (const off of this.offClient.splice(0)) off();
    const client = this.client;
    this.client = undefined;
    client?.close();
  }
  private updateVisibleLogs(): void {
    this.state.logs = this.allLogs
      .filter(
        (entry) =>
          !this.state.profile ||
          entry.scope === "global" ||
          entry.scope === `config:${this.state.profile}`
      )
      .slice(-MAX_LOGS);
  }
  private describe(value: unknown): string {
    return this.redactor.text(JSON.stringify(value, null, 2) ?? "").slice(0, 6000);
  }
  private activity(title: string, detail?: string, tone: WorkspaceActivity["tone"] = "info"): void {
    if (this.closed) return;
    this.state.activity.push({
      id: `activity-${++this.serial}`,
      title: this.redactor.text(title),
      ...(detail ? { detail: this.redactor.text(detail).slice(0, 6000) } : {}),
      tone,
    });
    if (this.state.activity.length > MAX_ACTIVITY)
      this.state.activity.splice(0, this.state.activity.length - MAX_ACTIVITY);
    this.publish();
  }
  private publish(): void {
    if (this.closed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(this.snapshot);
      } catch {
        /* UI observers cannot interrupt backend operations. */
      }
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function logKey(entry: BaasLogEntry): string {
  return JSON.stringify([entry.scope, entry.time, entry.level, entry.message]);
}
