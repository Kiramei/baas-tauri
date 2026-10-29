#!/usr/bin/env bun
import { BaasClient } from "@baas/client";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { parseArguments, tokenize } from "./arguments";
import {
  ACTIONS,
  executeAction,
  readPointer,
  resolveProfile,
  validateAction,
  type ActionContext,
  type Client,
} from "./actions";
import { listModels, runAgent, type AgentConfig, type AgentEvent } from "./agent";
import { createRedactor } from "./redaction";
import { followLogs, watchStatus, MonitorError, type MonitorEvent } from "./monitor";
import { newSession, SessionStore } from "./sessions";
import { loadInstructions } from "./instructions";
import { cancellationInput } from "./input";
import { DemoClient } from "./demo";
import { loadPacks } from "./packs";
import {
  DEFAULT_URL,
  loadSettings,
  normalizeEndpoint,
  saveSettings,
  settingsDirectory,
} from "./settings";
import { TerminalUI, terminalText } from "./ui";
import manifest from "../package.json";

const HELP = `BAAS CLI ${manifest.version} · 夏莱终端

用法  baas [全局选项] [命令]
      baas                         打开交互式终端
      baas --demo                  无需后端体验界面（内存演示）
      baas -p "查看国服运行状态"    单次自然语言 Agent

连接  init                         保存独立 CLI 配置（不保存 Key）
      connect [ws://host:8190]      连接服务，交互时隐式输入登录 Key
      login [model] / logout      隐藏输入本次 Key / 关闭本次服务连接
      doctor                       检查服务健康、认证和配置
      profiles                     列出配置档
      use <ID或唯一名称>            选择配置档

操作  status                       查看运行状态
      tasks                        查看任务和调度
      run <task> [--wait]          提交单任务，可等待真实运行结束
      wait [运行编号]              等待当前/指定运行，支持 --wait-timeout 秒数
      start / stop                 启动 / 停止调度
      config get [/path]           读取 JSON Pointer 路径
      config set /path '<JSON>'    修改已有配置字段
      devices                      检测 ADB 设备
      logs [数量] [--follow]       查看或实时跟随日志，断线恢复不重复提交任务

Agent agent <自然语言>              流式对话、调用 BAAS 工具
      packs                        查看独立指令包
      pack <命令名>                执行指令包中的步骤
      models                       从兼容模型服务获取列表并选择
      sessions / resume <ID>       查看和恢复本地会话
      new / context               新建会话 / 查看本地 BAAS.md 指令来源
      settings show|set|unset      管理非敏感偏好
      reload                       重新加载本地指令包和 BAAS.md

选项  --server <URL> / --pipe <路径>  WebSocket 或本地命名管道
      --profile <ID>               本次配置档
      --json                       机器可读 JSON，过程输出到 stderr
      --yes, -y                    明确批准本次状态修改
      --read-only                  禁止后端状态修改（也约束 Agent 和包）
      --dry-run                    预览修改和指令包步骤，不提交状态修改
      --wait --follow             等待任务完成 / 跟随相关日志
      --wait-timeout <秒>          最长等待（默认 300 秒）
      --resume <ID|latest>        恢复本地会话；--no-session 禁用会话保存
      --instructions <文件>       加载补充的 BAAS 专用指令
      --model <ID> --ai-url <URL>   OpenAI 兼容模型及 /v1 地址
      --timeout <毫秒>             后端请求超时（默认 15000）
      --server-key <公钥>          固定自部署服务的签名公钥
      --config-home <目录>         CLI 配置与自定义 commands 目录
      --no-color, -h, -v

交互模式支持 /help、/profiles、/use、/status、/tasks、/run、/start、/stop、
/config、/devices、/logs、/packs、/<指令包命令>、/model、/clear、/quit。
密钥通过 BAAS_KEY / BAAS_AI_API_KEY 或隐藏输入提供，不写入偏好文件。
模型可使用本地 OpenAI 兼容服务。普通命令不需要模型。`;

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { values } = options;
  const ui = new TerminalUI({ json: values.json, color: values["no-color"] ? false : undefined });
  if (values.help) {
    if (values.json) ui.result({ help: HELP });
    else process.stdout.write(`${HELP}\n`);
    return;
  }
  if (values.version) {
    ui.result(
      values.json ? { name: "baas", version: manifest.version } : `BAAS CLI ${manifest.version}`
    );
    return;
  }
  const directory = values["config-home"] || settingsDirectory();
  const preferences = await loadSettings(directory);
  const settings = { ...preferences };
  const secrets = new Set(
    [process.env.BAAS_KEY, process.env.BAAS_AI_API_KEY].filter((value): value is string => !!value)
  );
  let redactor = createRedactor([...secrets]);
  const sessionStore = new SessionStore(directory, (value) => redactor.value(value));
  settings.url = normalizeEndpoint(
    values.server || process.env.BAAS_SERVER || settings.url || DEFAULT_URL
  );
  settings.pipe =
    values.pipe ||
    (values.server || process.env.BAAS_SERVER ? undefined : process.env.BAAS_PIPE || settings.pipe);
  settings.profile = values.profile || process.env.BAAS_PROFILE || settings.profile;
  const selectedProfile = values.demo
    ? values.profile || process.env.BAAS_PROFILE || "sensei-cn"
    : settings.profile;
  const agentConfig: AgentConfig = {
    model: values.model || process.env.BAAS_AI_MODEL || process.env.BAAS_MODEL || settings.model,
    baseUrl: values["ai-url"] || process.env.BAAS_AI_BASE_URL || settings.aiBaseUrl,
    apiKey: process.env.BAAS_AI_API_KEY,
  };
  let instructions = await loadInstructions(directory, process.cwd(), values.instructions);
  let packs = await loadPacks(settings.packsDirectory || join(directory, "commands"));
  let packCommands = packs.flatMap((pack) =>
    pack.commands.map((command) => ({ ...command, pack: pack.id }))
  );
  const builtinNames = [
    "help",
    "init",
    "connect",
    "doctor",
    "profiles",
    "use",
    "status",
    "tasks",
    "run",
    "start",
    "stop",
    "config",
    "devices",
    "logs",
    "agent",
    "packs",
    "pack",
    "model",
    "clear",
    "quit",
    "exit",
    "wait",
    "watch",
    "models",
    "sessions",
    "resume",
    "new",
    "context",
    "settings",
    "reload",
    "login",
    "logout",
  ];
  for (const command of packCommands)
    if (builtinNames.includes(command.name))
      throw new Error(`指令包命令与内置命令重名：${command.name}`);
  const interactive =
    !values.print &&
    (options.positionals.length === 0 || options.positionals[0] === "resume") &&
    !!process.stdin.isTTY &&
    !values.json;
  let client: Client | undefined;
  let connected = false;
  let key = process.env.BAAS_KEY;
  let autoApprove = !!values.yes;
  const completions: Record<string, string[]> = {
    use: [],
    run: [],
    pack: packCommands.map((item) => item.name),
    model: [],
    resume: [],
    settings: ["show", "set", "unset"],
  };
  let history: Awaited<ReturnType<typeof runAgent>>["history"] = [];
  let session = newSession(
    values.demo ? "demo" : settings.pipe || settings.url,
    selectedProfile,
    agentConfig.model
  );
  let controller: AbortController | undefined;
  const onSignal = () => {
    if (controller) controller.abort();
    else {
      client?.close();
      process.exitCode = 130;
    }
  };
  process.on("SIGINT", onSignal);

  const requestApproval = async (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    approvalContext?: ActionContext
  ) => {
    signal?.throwIfAborted();
    if (context.readOnly) return false;
    if (autoApprove) return true;
    if (!process.stdin.isTTY || values.json)
      throw new Error("此操作会改变后端状态；请交互确认或显式传入 --yes");
    const effective = { ...args };
    if (["scheduler_start", "scheduler_stop", "task_run", "config_set"].includes(name)) {
      effective.profile = await resolveProfile(
        await context.client(signal),
        String(args.profile ?? context.profile ?? "")
      );
    }
    if (name === "config_set") {
      effective.before = Object.hasOwn(args, "before")
        ? args.before
        : structuredClone(
            readPointer(
              await (await context.client(signal)).config(String(effective.profile)),
              String(args.path)
            )
          );
      approvalContext?.approvalBaselines?.set(
        `${effective.profile}\0${args.path}`,
        effective.before
      );
    }
    signal?.throwIfAborted();
    ui.divider("操作确认");
    ui.result({ action: name, ...redactor.arguments(name, effective) });
    return ui.confirm("提交以上操作？", signal);
  };

  const context: ActionContext = {
    profile: selectedProfile,
    readOnly: !!values["read-only"],
    agentConfig,
    dryRun: !!values["dry-run"],
    wait: !!values.wait,
    follow: !!values.follow,
    waitTimeoutMs: options.waitTimeoutMs,
    approvalBaselines: new Map(),
    onEvent: (event) => monitorEvent(event),
    client: async (signal) => {
      signal?.throwIfAborted();
      if (!client) {
        if (!values.demo && !settings.pipe && !key) {
          if (!process.stdin.isTTY || values.json)
            throw new Error("WebSocket 连接需要 BAAS_KEY 环境变量；本地也可使用 --pipe");
          key = await ui.secret("BAAS 登录 Key（首次连接未初始化的服务时会设置此 Key）", signal);
          secrets.add(key);
          redactor = createRedactor([...secrets]);
          signal?.throwIfAborted();
          if (!key.trim()) throw new Error("登录 Key 不能为空");
        }
        client = values.demo
          ? new DemoClient()
          : new BaasClient({
              ...(settings.pipe ? { pipe: settings.pipe } : { url: settings.url }),
              key,
              timeoutMs: options.timeout,
              serverSignPublicKey: values["server-key"] || process.env.BAAS_SERVER_SIGN_PUBLIC_KEY,
            });
      }
      const current = client;
      await current.connect();
      signal?.throwIfAborted();
      connected = true;
      return current;
    },
    approve: (name, args) => requestApproval(name, args),
  };

  const animated =
    process.stdout.isTTY &&
    !values["no-color"] &&
    process.env.NO_COLOR === undefined &&
    process.env.TERM !== "dumb";
  let streamingLogs = false;
  const monitorEvent = (event: MonitorEvent) => {
    const safe = redactor.value(event) as MonitorEvent;
    if (values.json) {
      if (streamingLogs) ui.result(safe);
      else if (event.type === "connection") ui.info(redactor.text(event.message));
    } else ui.event(safe);
  };
  const withOperation = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (controller) return run(controller.signal);
    const operation = new AbortController();
    controller = operation;
    const releaseInput = cancellationInput(operation);
    const cancel = () => {
      if (values.demo) return;
      client?.close();
      client = undefined;
      connected = false;
    };
    operation.signal.addEventListener("abort", cancel, { once: true });
    const previous = context.signal;
    context.signal = operation.signal;
    try {
      return await run(operation.signal);
    } finally {
      context.signal = previous;
      releaseInput();
      operation.signal.removeEventListener("abort", cancel);
      controller = undefined;
    }
  };
  const action = async (name: string, args: Record<string, unknown> = {}) => {
    const stop = animated && !values.json ? ui.spinner(`BAAS · ${name}`) : () => {};
    try {
      return await withOperation(() => executeAction(name, args, context));
    } finally {
      stop();
    }
  };
  const show = (name: string, result: unknown) => {
    if (
      result &&
      typeof result === "object" &&
      (result as Record<string, unknown>).accepted === false &&
      (result as Record<string, unknown>).reason === "already-running"
    )
      process.exitCode = 1;
    if (name === "config_set") result = redactor.value(result);
    if (
      result &&
      typeof result === "object" &&
      (result as Record<string, unknown>).completed === true &&
      (result as Record<string, unknown>).succeeded === false
    )
      process.exitCode = 1;
    if (name === "profiles" && result && typeof result === "object")
      completions.use = Object.keys(result);
    if (name === "tasks" && result && typeof result === "object")
      completions.run = Object.keys(result);
    if (values.json) {
      ui.result(result);
      return;
    }
    const record = result && typeof result === "object" ? (result as Record<string, any>) : {};
    if (name === "profiles")
      ui.table(
        ["配置档 ID", "名称", "当前"],
        Object.entries(record).map(([id, label]) => [id, label, id === context.profile ? "●" : ""])
      );
    else if (name === "status")
      ui.table(
        ["配置档", "状态", "当前任务", "退出码"],
        Object.entries(record).map(([id, status]) => [
          id,
          status?.running ? "运行中" : "空闲",
          status?.current_task || "—",
          status?.exit_code ?? "—",
        ])
      );
    else if (name === "tasks")
      ui.table(
        ["任务", "名称", "启用", "调度"],
        Object.entries(record).map(([id, task]) => [
          id,
          task?.name || task?.display_name || task?.event_name || id,
          task?.enabled ?? task?.enable ?? "—",
          task?.next_tick ?? task?.next_time ?? "—",
        ])
      );
    else if (name === "logs" && Array.isArray(result))
      ui.table(
        ["时间", "级别", "范围", "内容"],
        result.map((entry) => [entry.time, entry.level, entry.scope, entry.message])
      );
    else ui.result(result);
  };

  const askAgent = async (prompt: string) => {
    if (!prompt.trim()) throw new Error("请输入想让 BAAS 执行的任务");
    controller = new AbortController();
    const runController = controller;
    const releaseInput = cancellationInput(runController);
    const runContext: ActionContext = {
      ...context,
      signal: runController.signal,
      approvalBaselines: new Map(),
      waitTimeoutMs: Math.min(context.waitTimeoutMs || 120000, 120000),
      approve: (name, args) => requestApproval(name, args, runController.signal, runContext),
    };
    const toolEvents: AgentEvent[] = [];
    const onAbort = () => {
      if (values.demo) return;
      client?.close();
      client = undefined;
      connected = false;
    };
    runController.signal.addEventListener("abort", onAbort, { once: true });
    const stop =
      animated && !values.json
        ? ui.spinner(`正在连接模型 · ${agentConfig.model || "尚未配置"}`)
        : () => {};
    try {
      const result = await runAgent({
        prompt,
        config: agentConfig,
        actions: ACTIONS.filter((item) => !context.readOnly || !item.mutating).map((item) => ({
          ...item,
          mutating: item.mutating && !context.dryRun,
          description: `${item.description} 当前 CLI 选择的配置档为 ${JSON.stringify(context.profile ?? null)}；省略 profile 参数使用该选择。`,
        })),
        history,
        instructions: instructions
          .map(
            (source) =>
              `<baas-context source=${JSON.stringify(source.path)}>\n${source.text}\n</baas-context>`
          )
          .join("\n\n"),
        secrets: [...secrets],
        signal: runController.signal,
        execute: async (name, args, signal) => {
          runContext.signal = signal;
          const cancel = () => {
            if (values.demo) return;
            client?.close();
            client = undefined;
            connected = false;
          };
          signal.addEventListener("abort", cancel, { once: true });
          try {
            const result = await executeAction(name, args, runContext, true);
            context.lastRun = runContext.lastRun;
            return result;
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        },
        approve: (name, args, signal) => requestApproval(name, args, signal, runContext),
        onEvent: (event) => {
          if (!values.json) ui.event(event);
          else if (event.type !== "text-delta" && event.type !== "finish") toolEvents.push(event);
        },
      });
      history = result.history;
      if (!values["no-session"]) {
        session = {
          ...session,
          profile: context.profile,
          model: agentConfig.model,
          title: session.messages.length ? session.title : redactor.text(prompt).slice(0, 100),
          messages: history,
        };
        try {
          await sessionStore.save(session);
        } catch (error) {
          ui.error(`会话未保存：${redactor.text((error as Error).message)}`);
        }
      }
      if (values.json)
        ui.result({
          text: result.text,
          model: agentConfig.model,
          tools: toolEvents,
          ...(!values["no-session"] ? { session_id: session.id } : {}),
        });
    } finally {
      stop();
      releaseInput();
      runController.signal.removeEventListener("abort", onAbort);
      controller = undefined;
    }
  };

  const restoreSession = async (id: string) => {
    if (values["no-session"]) throw new Error("--no-session 模式不能恢复会话");
    const restored = await sessionStore.load(id);
    const endpoint = values.demo ? "demo" : settings.pipe || settings.url;
    if (restored.endpoint !== endpoint)
      throw new Error(
        `会话属于另一后端，请明确使用对应 --server 或 --pipe 再恢复：${restored.endpoint}`
      );
    const explicitProfile = values.profile || process.env.BAAS_PROFILE;
    if (explicitProfile && restored.profile && explicitProfile !== restored.profile)
      throw new Error("指定配置档与会话绑定的配置档不同，请选择匹配的会话或新建会话");
    session = restored;
    history = restored.messages;
    context.profile = restored.profile;
    context.lastRun = undefined;
    if (!values.model && !process.env.BAAS_AI_MODEL && !process.env.BAAS_MODEL && restored.model)
      agentConfig.model = restored.model;
    return {
      session_id: session.id,
      title: session.title,
      profile: context.profile,
      messages: history.length,
      model: agentConfig.model,
    };
  };

  const execute = async (words: string[]): Promise<boolean> => {
    const local = parseArguments(words);
    const [command = "help", ...args] = local.positionals;
    for (const flag of Object.keys(local.values)) {
      if (
        !["yes", "read-only", "dry-run", "wait", "follow", "wait-timeout", "profile"].includes(flag)
      )
        throw new Error(`--${flag} 是启动选项；请在启动 baas 时设置，或使用 /help 查看交互命令`);
    }
    const previous = {
      wait: context.wait,
      follow: context.follow,
      dryRun: context.dryRun,
      waitTimeoutMs: context.waitTimeoutMs,
      profile: context.profile,
      readOnly: context.readOnly,
      autoApprove,
    };
    if (local.values.profile && command === "agent" && local.values.profile !== previous.profile)
      throw new Error("Agent 会话绑定当前配置档；请先用 /use 切换后再开始对话");
    autoApprove = !!(local.values.yes ?? previous.autoApprove);
    context.readOnly = previous.readOnly || !!local.values["read-only"];
    context.wait = local.values.wait ?? previous.wait;
    context.follow = local.values.follow ?? previous.follow;
    context.dryRun = local.values["dry-run"] ?? previous.dryRun;
    context.waitTimeoutMs = local.values["wait-timeout"]
      ? local.waitTimeoutMs
      : previous.waitTimeoutMs;
    if (["run", "start"].includes(command) && context.follow) context.wait = true;
    if (local.values.profile) context.profile = local.values.profile;
    const expect = (minimum: number, maximum = minimum) => {
      if (args.length < minimum || args.length > maximum)
        throw new Error(`参数数量有误，请用 /help 查看 ${command} 的用法`);
    };
    try {
      switch (command) {
        case "help":
          if (values.json) ui.result({ help: HELP });
          else process.stdout.write(`${HELP}\n`);
          break;
        case "quit":
        case "exit":
          expect(0);
          return false;
        case "clear":
        case "new":
          expect(0);
          history = [];
          context.lastRun = undefined;
          session = newSession(
            values.demo ? "demo" : settings.pipe || settings.url,
            context.profile,
            agentConfig.model
          );
          ui.result({ session_id: session.id, message: "已开始新会话" });
          break;
        case "init": {
          expect(0);
          if (process.stdin.isTTY && !values.json && !values.server && !values.pipe) {
            const endpoint = (await ui.prompt(`服务地址 [${settings.url}]`)).trim();
            if (endpoint) {
              settings.url = normalizeEndpoint(endpoint);
              settings.pipe = undefined;
            }
          }
          settings.model = agentConfig.model;
          settings.aiBaseUrl = agentConfig.baseUrl;
          Object.assign(preferences, settings);
          const path = await saveSettings(settings, directory);
          ui.result({ saved: path, settings, credentials: "BAAS_KEY / BAAS_AI_API_KEY 环境变量" });
          break;
        }
        case "connect": {
          expect(0, 1);
          client?.close();
          client = undefined;
          connected = false;
          if (args[0]) {
            settings.url = normalizeEndpoint(args[0]);
            settings.pipe = undefined;
            key = process.env.BAAS_KEY;
            history = [];
            context.lastRun = undefined;
            session = newSession(
              values.demo ? "demo" : settings.url,
              context.profile,
              agentConfig.model
            );
          }
          await context.client();
          completions.use = Object.keys(await (await context.client()).profiles());
          if (context.profile)
            completions.run = Object.keys(
              await (
                await context.client()
              ).tasks(await resolveProfile(await context.client(), context.profile))
            );
          ui.result({
            connected: true,
            endpoint: values.demo ? "demo (内存)" : settings.pipe || settings.url,
          });
          break;
        }
        case "doctor": {
          expect(0);
          if (values.demo || settings.pipe) {
            await context.client();
            ui.result({
              ok: true,
              transport: values.demo ? "demo" : "pipe",
              endpoint: settings.pipe,
              profiles: await action("profiles"),
            });
          } else {
            const url = settings.url.replace(/^ws/, "http");
            const response = await fetch(`${url}/health`, {
              signal: AbortSignal.timeout(options.timeout),
            });
            if (!response.ok) throw new Error(`健康检查失败：HTTP ${response.status}`);
            const health = (await response.json()) as Record<string, unknown>;
            ui.result({
              endpoint: settings.url,
              health,
              keyAvailable: !!key,
              modelConfigured: !!agentConfig.model && !!agentConfig.baseUrl,
              note: "健康检查成功不代表已认证或设备任务执行成功",
            });
          }
          break;
        }
        case "login": {
          expect(0, 1);
          if (args[0] && args[0] !== "model") throw new Error("用法：login 或 login model");
          await withOperation(async (signal) => {
            const credential = await ui.secret(
              args[0] === "model" ? "模型 API Key（仅本次进程使用）" : "BAAS 登录 Key",
              signal
            );
            if (!credential.trim()) throw new Error("Key 不能为空");
            secrets.add(credential);
            redactor = createRedactor([...secrets]);
            if (args[0] === "model") agentConfig.apiKey = credential;
            else {
              client?.close();
              client = undefined;
              connected = false;
              key = credential;
              await context.client(signal);
            }
          });
          ui.result(args[0] === "model" ? { model_key_configured: true } : { authenticated: true });
          break;
        }
        case "logout":
          expect(0);
          client?.close();
          client = undefined;
          connected = false;
          key = undefined;
          history = [];
          context.lastRun = undefined;
          session = newSession(
            values.demo ? "demo" : settings.pipe || settings.url,
            context.profile,
            agentConfig.model
          );
          ui.result({ connected: false });
          break;
        case "profiles":
        case "status":
        case "tasks":
        case "devices":
          expect(0);
          if (command === "status" && context.follow) return await execute(["watch"]);
          show(command, await action(command));
          break;
        case "watch":
          expect(0);
          await withOperation(async (signal) => {
            const service = await context.client(signal);
            const profile = context.profile
              ? await resolveProfile(service, context.profile)
              : undefined;
            streamingLogs = true;
            try {
              await watchStatus(service, { profile, signal, onEvent: monitorEvent });
            } finally {
              streamingLogs = false;
            }
          });
          break;
        case "use": {
          expect(0, 1);
          let target = args[0];
          if (!target && interactive) {
            const profiles = await (await context.client()).profiles();
            target =
              (await ui.select({
                title: "选择配置档",
                initial: context.profile,
                items: Object.entries(profiles).map(([value, label]) => ({
                  value,
                  label,
                  description: value,
                })),
              })) || "";
            if (!target) break;
          }
          const selected = await resolveProfile(await context.client(), target);
          if (selected !== context.profile) {
            history = [];
            context.lastRun = undefined;
            session = newSession(
              values.demo ? "demo" : settings.pipe || settings.url,
              selected,
              agentConfig.model
            );
          }
          context.profile = selected;
          completions.run = Object.keys(await (await context.client()).tasks(selected));
          if (!values.demo) {
            settings.profile = context.profile;
            preferences.profile = context.profile;
            await saveSettings(preferences, directory);
          }
          ui.result({ profile: context.profile });
          break;
        }
        case "run":
          expect(1);
          show("task_run", await action("task_run", { task: args[0] }));
          break;
        case "wait":
          expect(0, 1);
          show("wait_run", await action("wait_run", args[0] ? { run_id: args[0] } : {}));
          break;
        case "start":
        case "stop":
          expect(0);
          show(command, await action(command === "start" ? "scheduler_start" : "scheduler_stop"));
          break;
        case "logs":
          expect(0, 1);
          if (context.follow)
            await withOperation(async (signal) => {
              const service = await context.client(signal);
              const profile = context.profile
                ? await resolveProfile(service, context.profile)
                : undefined;
              const limit = args[0] ? Number(args[0]) : 30;
              validateAction("logs", { limit });
              streamingLogs = true;
              try {
                await followLogs(service, { profile, limit, signal, onEvent: monitorEvent });
              } finally {
                streamingLogs = false;
              }
            });
          else show("logs", await action("logs", { limit: args[0] ? Number(args[0]) : 30 }));
          break;
        case "config": {
          const [mode, path = "", ...value] = args;
          if (mode === "get" && args.length <= 2)
            show("config_get", await action("config_get", { path }));
          else if (mode === "set" && path && value.length) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(value.join(" "));
            } catch {
              throw new Error("配置值必须是有效 JSON；字符串示例：config set /name '\"夏莱\"'");
            }
            show("config_set", await action("config_set", { path, value: parsed }));
          } else throw new Error("用法：config get [/path] 或 config set /path '<JSON>'");
          break;
        }
        case "model": {
          expect(0, 1);
          if (!args[0] && interactive) return await execute(["models"]);
          if (args[0]) agentConfig.model = args[0];
          ui.result({
            model: agentConfig.model || null,
            baseUrl: agentConfig.baseUrl || null,
            keyAvailable: !!agentConfig.apiKey,
          });
          break;
        }
        case "models": {
          expect(0);
          const models = await withOperation((signal) => listModels(agentConfig, signal));
          completions.model = models.map((model) => model.id);
          if (interactive) {
            const selected = await ui.select({
              title: "选择模型",
              initial: agentConfig.model,
              items: models.map((model) => ({
                value: model.id,
                label: model.id,
                description: model.ownedBy,
              })),
            });
            if (selected) {
              agentConfig.model = selected;
              preferences.model = selected;
              await saveSettings(preferences, directory);
              ui.result({ model: selected });
            }
          } else ui.result(models);
          break;
        }
        case "sessions": {
          expect(0);
          const sessions = await sessionStore.list();
          completions.resume = sessions.map((item) => item.id);
          if (values.json) ui.result(sessions);
          else
            ui.table(
              ["会话 ID", "标题", "配置档", "更新时间"],
              sessions.map((item) => [item.id, item.title, item.profile || "—", item.updatedAt])
            );
          break;
        }
        case "resume": {
          expect(0, 1);
          let target = args[0];
          if (!target && interactive) {
            const sessions = await sessionStore.list();
            target =
              (await ui.select({
                title: "恢复会话",
                items: sessions.map((item) => ({
                  value: item.id,
                  label: item.title,
                  description: `${item.profile || "无配置档"} · ${item.updatedAt} · ${item.id}`,
                })),
              })) || "";
            if (!target) break;
          }
          ui.result(await restoreSession(target || "latest"));
          break;
        }
        case "context":
          expect(0);
          ui.result({
            sources: instructions.map((item) => ({
              path: item.path,
              characters: item.text.length,
            })),
            profile: context.profile,
            session_id: session.id,
          });
          break;
        case "reload": {
          expect(0);
          const nextPacks = await loadPacks(settings.packsDirectory || join(directory, "commands"));
          const nextCommands = nextPacks.flatMap((pack) =>
            pack.commands.map((command) => ({ ...command, pack: pack.id }))
          );
          for (const command of nextCommands)
            if (builtinNames.includes(command.name))
              throw new Error(`指令包命令与内置命令重名：${command.name}`);
          const nextInstructions = await loadInstructions(
            directory,
            process.cwd(),
            values.instructions
          );
          packs = nextPacks;
          packCommands = nextCommands;
          instructions = nextInstructions;
          completions.pack = packCommands.map((item) => item.name);
          ui.result({
            packs: packs.length,
            commands: packCommands.length,
            instructionSources: instructions.length,
          });
          break;
        }
        case "settings": {
          const [operation = "show", field, value] = args;
          const fields = [
            "url",
            "pipe",
            "profile",
            "model",
            "aiBaseUrl",
            "packsDirectory",
          ] as const;
          if (operation === "show" && args.length <= 1) {
            ui.result({
              path: join(directory, "settings.json"),
              saved: preferences,
              effective: settings,
              model: agentConfig.model,
              aiBaseUrl: agentConfig.baseUrl,
            });
            break;
          }
          if (
            !["set", "unset"].includes(operation) ||
            !fields.includes(field as (typeof fields)[number]) ||
            args.length !== (operation === "set" ? 3 : 2)
          )
            throw new Error(
              `用法：settings show / settings set <${fields.join("|")}> <值> / settings unset <字段>`
            );
          let next = operation === "unset" ? undefined : value;
          if (next !== undefined && (!next.trim() || next.length > 4096))
            throw new Error("偏好值不能为空且最多 4096 个字符");
          if (field === "url") next = normalizeEndpoint(next || DEFAULT_URL);
          if (field === "aiBaseUrl" && next) {
            const endpoint = new URL(next);
            if (
              !["https:", "http:"].includes(endpoint.protocol) ||
              endpoint.username ||
              endpoint.password ||
              endpoint.search ||
              endpoint.hash
            )
              throw new Error("模型地址必须是无内嵌凭据的 HTTP(S) 地址");
          }
          if (field === "packsDirectory" && next) next = resolve(next);
          const saved = { ...preferences, [field]: next };
          if (field === "url") saved.pipe = undefined;
          await saveSettings(saved, directory);
          Object.assign(preferences, saved);
          Object.assign(settings, { [field]: next });
          if (field === "model") agentConfig.model = next;
          if (field === "aiBaseUrl") agentConfig.baseUrl = next;
          if (["url", "pipe", "profile"].includes(field)) {
            client?.close();
            client = undefined;
            connected = false;
            history = [];
            context.lastRun = undefined;
            if (field === "url") settings.pipe = undefined;
            if (["url", "pipe"].includes(field)) key = process.env.BAAS_KEY;
            if (field === "profile") context.profile = next;
            session = newSession(
              values.demo ? "demo" : settings.pipe || settings.url,
              context.profile,
              agentConfig.model
            );
          }
          ui.result({ saved: join(directory, "settings.json"), field, value: next ?? null });
          break;
        }
        case "agent":
          await askAgent(args.join(" "));
          break;
        case "packs":
          expect(0);
          ui.result(
            packs.map((pack) => ({
              id: pack.id,
              name: pack.name,
              description: pack.description,
              commands: pack.commands.map((item) => ({
                name: item.name,
                description: item.description,
                steps: item.steps,
              })),
            }))
          );
          break;
        case "pack": {
          expect(1);
          const pack = packCommands.find((item) => item.name === args[0]);
          if (!pack) throw new Error(`指令包命令不存在：${args[0]}；请用 /packs 查看`);
          // Validate the entire plan before the first step can change backend state.
          for (const step of pack.steps) {
            const definition = validateAction(step.action, step.args);
            if (definition.mutating && context.readOnly)
              throw new Error("当前为只读模式，指令包包含状态修改，未执行任何步骤");
            if (
              [
                "tasks",
                "config_get",
                "config_set",
                "scheduler_start",
                "scheduler_stop",
                "task_run",
                "wait_run",
              ].includes(step.action)
            ) {
              const service = await context.client();
              const profile = await resolveProfile(
                service,
                String(step.args.profile ?? context.profile ?? "")
              );
              if (
                step.action === "task_run" &&
                !Object.hasOwn(await service.tasks(profile), String(step.args.task))
              )
                throw new Error(`指令包任务不存在：${step.args.task}；未执行任何步骤`);
              if (step.action === "config_set")
                readPointer(await service.config(profile), String(step.args.path));
            }
          }
          if (context.dryRun) {
            ui.result(
              redactor.value({
                dry_run: true,
                command: pack.name,
                pack: pack.pack,
                steps: pack.steps,
              })
            );
            break;
          }
          const results = [];
          for (const step of pack.steps) {
            ui.info(`${pack.name} → ${step.action}`);
            const result = await action(step.action, step.args);
            results.push({ action: step.action, result });
            const state = result as Record<string, unknown> | undefined;
            if (state?.accepted === false && state?.reason === "already-running")
              throw new MonitorError(
                "already_running",
                "指令包中止：已有运行，本次没有提交新任务",
                result
              );
            if (state?.completed && state.succeeded === false) {
              process.exitCode = 1;
              break;
            }
          }
          ui.result({ command: pack.name, pack: pack.pack, results });
          break;
        }
        default:
          if (packCommands.some((pack) => pack.name === command))
            return await execute(["pack", command, ...args]);
          throw new Error(`未知命令：${command}；自然语言使用 agent <问题> 或 -p <问题>`);
      }
      return true;
    } finally {
      context.wait = previous.wait;
      context.follow = previous.follow;
      context.dryRun = previous.dryRun;
      context.waitTimeoutMs = previous.waitTimeoutMs;
      context.readOnly = previous.readOnly;
      autoApprove = previous.autoApprove;
      if (local.values.profile && command !== "use") context.profile = previous.profile;
    }
  };

  try {
    if (values.resume) await restoreSession(values.resume);
    if (interactive && options.positionals[0] === "resume")
      await restoreSession(options.positionals[1] || "latest");
    if (interactive) {
      if (values.demo) {
        const demo = await context.client();
        completions.use = Object.keys(await demo.profiles());
        completions.run = Object.keys(await demo.tasks(context.profile!));
      }
      ui.welcome({
        version: manifest.version,
        endpoint: values.demo ? "DEMO · 内存演示" : settings.pipe || settings.url,
        profile: context.profile,
        mode: context.readOnly ? "只读" : agentConfig.model ? "Agent" : "命令",
        connected,
      });
      if (values.demo) ui.info("演示模式：所有操作仅作用于内存，不会连接真实设备。");
      else ui.info("输入 /connect 连接后端；/help 查看指令。普通命令无需配置模型。");
      ui.info("Tab 补全 · ↑↓ 历史 · Ctrl+C 取消 · Ctrl+D 退出");
      const inputHistory: string[] = [];
      let open = true;
      while (open) {
        ui.divider();
        const line = await readLine(
          context.profile || "未选择配置档",
          [...builtinNames, ...packCommands.map((item) => item.name)],
          inputHistory,
          completions
        );
        if (line === null) break;
        if (!line.trim()) continue;
        inputHistory.unshift(line);
        inputHistory.splice(100);
        try {
          open = line.startsWith("/")
            ? await execute(tokenize(line.slice(1)))
            : (await askAgent(line), true);
        } catch (error) {
          if ((error as Error).name === "AbortError")
            ui.info("已取消本次等待/请求；后端已提交的任务不会自动停止");
          else ui.error(redactor.text((error as Error).message));
        }
      }
    } else if (values.print) await askAgent(values.print);
    else if (options.positionals.length) await execute(options.positionals);
    else if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 65536) throw new Error("标准输入最多支持 64 KiB");
        chunks.push(buffer);
      }
      const prompt = Buffer.concat(chunks).toString("utf8").trim();
      if (prompt) await askAgent(prompt);
      else throw new Error("请指定命令；使用 --help 查看帮助");
    } else throw new Error("--json 需要指定命令或 -p 提示词");
  } finally {
    client?.close();
    process.removeListener("SIGINT", onSignal);
  }
}

function readLine(
  profile: string,
  commands: string[],
  history: string[],
  completions: Record<string, string[]>
): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      history,
      terminal: true,
      completer: (line: string) => {
        const argument = /^\/(\S+)\s+(.*)$/.exec(line);
        const candidates = argument
          ? (completions[argument[1]] || []).map((item) => `/${argument[1]} ${item}`)
          : commands.map((item) => `/${item}`);
        const matches = candidates.filter((item) => item.startsWith(line));
        return [matches, line];
      },
    });
    let settled = false;
    const finish = (line: string | null) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(line);
    };
    rl.on("close", () => finish(null));
    rl.on("SIGINT", () => {
      process.stdout.write("\n");
      finish("");
    });
    const safeProfile = terminalText(profile).replace(/\n/g, " ").slice(0, 50);
    rl.question(`\n  ${safeProfile} ❯ `, (line) => finish(line));
  });
}

main().catch((error) => {
  const json = process.argv.includes("--json");
  const safe = createRedactor([process.env.BAAS_KEY, process.env.BAAS_AI_API_KEY]);
  const message = safe.text((error as Error).message);
  const details =
    error instanceof MonitorError
      ? {
          code: error.code,
          ...(error.details !== undefined ? { details: safe.value(error.details) } : {}),
        }
      : {};
  if (json) process.stdout.write(`${JSON.stringify({ error: message, ...details })}\n`);
  else process.stderr.write(`\n  ! ${terminalText(message)}\n`);
  process.exitCode =
    process.exitCode === 130 || (error as Error).name === "AbortError"
      ? 130
      : error instanceof MonitorError && error.code === "wait_timeout"
        ? 124
        : 1;
});
