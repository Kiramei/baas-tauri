#!/usr/bin/env bun
import { BaasClient } from "@baas/client";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { RuntimeManager } from "./runtime";
import { parseArguments } from "./arguments";
import {
  executeAction,
  prepareConfigurationChange,
  resolveProfile,
  validateAction,
  type ActionContext,
  type Client,
} from "./actions";
import { createRedactor } from "./redaction";
import { abortable, followLogs, watchStatus, MonitorError, type MonitorEvent } from "./monitor";
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
import { help } from "./help";

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { values } = options;
  const language =
    values.lang ||
    process.env.BAAS_LANG ||
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANG ||
    "en";
  const noColor = !!values["no-color"] || process.env.NO_COLOR !== undefined;
  if (noColor) process.env.FORCE_COLOR = "0";
  const ui = new TerminalUI({ json: values.json, color: noColor ? false : undefined });
  if (values.help) {
    if (values.json) ui.result({ help: help(language, manifest.version) });
    else process.stdout.write(help(language, manifest.version));
    return;
  }
  if (values.version) {
    ui.result(
      values.json ? { name: "baasx", version: manifest.version } : `baasx ${manifest.version}`
    );
    return;
  }
  const directory = values["config-home"] || settingsDirectory();
  if (process.stdin.isTTY && options.positionals.length === 0 && !values.json) {
    const { launchWorkspace } = await import("./workspace-view");
    await launchWorkspace({
      demo: values.demo,
      readOnly: values["read-only"],
      yes: values.yes,
      dryRun: values["dry-run"],
      server: values.server,
      pipe: values.pipe,
      profile: values.profile,
      key: process.env.BAAS_KEY,
      serverKey: values["server-key"] || process.env.BAAS_SERVER_SIGN_PUBLIC_KEY,
      timeout: options.timeout,
      directory,
      lang: values.lang || process.env.BAAS_LANG,
      noColor,
    });
    return;
  }
  if (!options.positionals.length)
    throw new Error("请指定 baasx 命令；使用 --help 查看帮助。管道输入不会自动执行任务。");
  const preferences = await loadSettings(directory);
  const settings = { ...preferences };
  settings.url = normalizeEndpoint(
    values.server || process.env.BAAS_SERVER || settings.url || DEFAULT_URL
  );
  settings.pipe =
    values.pipe ||
    (values.server || process.env.BAAS_SERVER ? undefined : process.env.BAAS_PIPE || settings.pipe);
  settings.profile = values.profile || process.env.BAAS_PROFILE || settings.profile;
  settings.language = values.lang || process.env.BAAS_LANG || settings.language;
  let packs = await loadPacks(settings.packsDirectory || join(directory, "commands"));
  let packCommands = packs.flatMap((pack) =>
    pack.commands.map((command) => ({ ...command, pack: pack.id }))
  );
  const builtinNames = new Set([
    "help",
    "init",
    "connect",
    "login",
    "logout",
    "doctor",
    "profiles",
    "profile",
    "use",
    "status",
    "tasks",
    "run",
    "start",
    "stop",
    "wait",
    "watch",
    "config",
    "devices",
    "logs",
    "packs",
    "pack",
    "settings",
    "reload",
    "check-update",
    "update",
  ]);
  for (const command of packCommands)
    if (builtinNames.has(command.name))
      throw new Error(`指令包命令与内置命令重名：${command.name}`);
  let client: Client | undefined;
  let ownedRuntime: RuntimeManager | undefined;
  let localStarted = false;
  let useLocalRuntime =
    !values.demo &&
    !values.server &&
    !values.pipe &&
    !process.env.BAAS_SERVER &&
    !process.env.BAAS_PIPE &&
    (preferences.connectionMode === "local" ||
      (!preferences.connectionMode &&
        !preferences.pipe &&
        preferences.url === DEFAULT_URL &&
        existsSync(join(directory, "runtime.json"))));
  let key = process.env.BAAS_KEY;
  const secrets = new Set(key ? [key] : []);
  let redactor = createRedactor([...secrets]);
  let controller: AbortController | undefined;
  const onSignal = () => {
    if (controller) controller.abort();
    else {
      client?.close();
      ownedRuntime?.close();
      process.exitCode = 130;
    }
  };
  process.on("SIGINT", onSignal);
  const context: ActionContext = {
    profile: values.demo
      ? values.profile || process.env.BAAS_PROFILE || "sensei-cn"
      : settings.profile,
    readOnly: !!values["read-only"],
    dryRun: !!values["dry-run"],
    wait: useLocalRuntime || !!values.wait || !!values.follow,
    follow: !!values.follow,
    waitTimeoutMs:
      useLocalRuntime && values["wait-timeout"] === undefined ? 86_400_000 : options.waitTimeoutMs,
    approvalBaselines: new Map(),
    language: settings.language,
    onEvent: (event) => monitorEvent(event),
    client: async (signal) => {
      signal?.throwIfAborted();
      if (!client) {
        if (useLocalRuntime && !localStarted) {
          const { RuntimeManager } = await import("./runtime");
          ownedRuntime ||= new RuntimeManager({ directory });
          const { pipe } = await ownedRuntime.start((event) => {
            if (event.message) ui.info(redactor.text(event.message));
          }, signal);
          settings.pipe = pipe;
          localStarted = true;
        }
        if (!values.demo && !settings.pipe && !key) {
          if (!process.stdin.isTTY || values.json)
            throw new Error("WebSocket 连接需要 BAAS_KEY 环境变量；本地也可使用 --pipe");
          key = await ui.secret("BAAS 登录 Key", signal);
          if (!key.trim()) throw new Error("登录 Key 不能为空");
          secrets.add(key);
          redactor = createRedactor([...secrets]);
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
      await client.connect();
      signal?.throwIfAborted();
      return client;
    },
    approve: async (name, args) => {
      context.signal?.throwIfAborted();
      if (context.readOnly) return false;
      if (values.yes) return true;
      if (!process.stdin.isTTY || values.json)
        throw new Error("此操作会改变后端状态；请交互确认或显式传入 --yes");
      ui.divider("操作确认");
      ui.result({ action: name, ...redactor.arguments(name, args) });
      return ui.confirm("提交以上操作？", context.signal);
    },
  };
  let streaming = false;
  const monitorEvent = (event: MonitorEvent) => {
    const safe = redactor.value(event) as MonitorEvent;
    if (!values.json || streaming) ui.event(safe);
    else if (safe.type === "connection") ui.info(safe.message);
  };
  const withOperation = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (controller) return run(controller.signal);
    const operation = new AbortController();
    controller = operation;
    const release = cancellationInput(operation);
    const cancel = () => {
      if (!values.demo) {
        client?.close();
        client = undefined;
      }
    };
    operation.signal.addEventListener("abort", cancel, { once: true });
    context.signal = operation.signal;
    try {
      return await run(operation.signal);
    } finally {
      release();
      operation.signal.removeEventListener("abort", cancel);
      context.signal = undefined;
      controller = undefined;
    }
  };
  const action = (name: string, args: Record<string, unknown> = {}) =>
    withOperation(() => executeAction(name, args, context));
  const show = (name: string, value: unknown) => {
    const result = name === "config_set" ? redactor.value(value) : value;
    const record = result && typeof result === "object" ? (result as Record<string, any>) : {};
    if (
      (record.accepted === false && record.reason === "already-running") ||
      (record.completed && record.succeeded === false)
    )
      process.exitCode = 1;
    if (values.json) {
      ui.result(result);
      return;
    }
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
  const execute = async (words: string[]): Promise<void> => {
    const [command, ...args] = words;
    const expect = (minimum: number, maximum = minimum) => {
      if (args.length < minimum || args.length > maximum)
        throw new Error(`参数数量有误，请用 --help 查看 ${command} 的用法`);
    };
    switch (command) {
      case "help":
        expect(0);
        if (values.json) ui.result({ help: help(language, manifest.version) });
        else process.stdout.write(help(language, manifest.version));
        break;
      case "init": {
        expect(0);
        await saveSettings(settings, directory);
        ui.result({
          saved: join(directory, "settings.json"),
          settings,
          credentials: "BAAS_KEY 环境变量或隐藏输入",
        });
        break;
      }
      case "connect": {
        expect(0, 1);
        if (args[0]) {
          useLocalRuntime = false;
          settings.url = normalizeEndpoint(args[0]);
          settings.pipe = undefined;
        }
        await context.client();
        ui.result({
          connected: true,
          endpoint: values.demo ? "demo (内存)" : settings.pipe || settings.url,
        });
        break;
      }
      case "login": {
        expect(0);
        await withOperation(async (signal) => {
          key = await ui.secret("BAAS 登录 Key", signal);
          if (!key.trim()) throw new Error("Key 不能为空");
          secrets.add(key);
          redactor = createRedactor([...secrets]);
          client?.close();
          client = undefined;
          await context.client(signal);
        });
        ui.result({ authenticated: true });
        break;
      }
      case "logout":
        expect(0);
        client?.close();
        client = undefined;
        key = undefined;
        ui.result({ connected: false });
        break;
      case "doctor": {
        expect(0);
        if (values.demo || settings.pipe || useLocalRuntime) {
          await context.client();
          ui.result({
            ok: true,
            transport: values.demo ? "demo" : "pipe",
            endpoint: settings.pipe,
            profiles: await action("profiles"),
          });
        } else {
          const response = await fetch(`${settings.url.replace(/^ws/, "http")}/health`, {
            signal: AbortSignal.timeout(options.timeout),
          });
          if (!response.ok) throw new Error(`健康检查失败：HTTP ${response.status}`);
          ui.result({
            endpoint: settings.url,
            health: await response.json(),
            keyAvailable: !!key,
            note: "健康检查成功不代表已认证或设备任务执行成功",
          });
        }
        break;
      }
      case "check-update":
      case "update": {
        expect(0);
        if (values.demo) throw new Error("演示环境不检查或更新真实后端");
        if (command === "update" && context.readOnly)
          throw new Error("当前为只读模式，不能更新运行环境");
        const result = await withOperation(async (signal) => {
          const { RuntimeManager } = await import("./runtime");
          ownedRuntime ||= new RuntimeManager({ directory });
          const progress = (event: { message: string }) => {
            if (event.message) ui.info(redactor.text(event.message));
          };
          const check = await ownedRuntime.checkUpdates(progress, signal);
          if (command === "check-update") return check;
          if (!check.available) return { updated: false, reason: "already-current", ...check };
          if (context.dryRun) return { dry_run: true, action: "update", ...check };
          if (
            !(await context.approve("update", {
              root: check.root,
              repositories: check.repositories,
            }))
          )
            throw new Error("操作已取消，未更新运行环境");
          signal.throwIfAborted();
          await ownedRuntime.stopWhenIdle(signal);
          const runtime = await ownedRuntime.update(progress, signal);
          return { updated: true, runtime };
        });
        ui.result(result);
        break;
      }
      case "profiles":
      case "status":
      case "tasks":
      case "devices":
        expect(0);
        show(command, await action(command));
        break;
      case "use": {
        expect(1);
        context.profile = await resolveProfile(await context.client(), args[0]);
        if (!values.demo) {
          preferences.profile = context.profile;
          await saveSettings(preferences, directory);
        }
        ui.result({ profile: context.profile });
        break;
      }
      case "profile": {
        expect(3);
        if (args[0] !== "create") throw new Error('用法：profile create "配置档名称" "服务器"');
        if (context.readOnly) throw new Error("当前为只读模式，不能新建配置档");
        const name = args[1].trim(),
          server = args[2].trim();
        if (!name || name.length > 80 || terminalText(name) !== name || name.includes("\n"))
          throw new Error("配置档名称需要 1–80 个字符，且不能包含终端控制字符或换行");
        const servers = [
          "官服",
          "B服",
          "国际服",
          "国际服青少年",
          "韩国ONE",
          "日服",
          ...(process.platform === "win32" ? ["日服PC端", "Steam国际服"] : []),
        ];
        if (!servers.includes(server)) throw new Error(`服务器无效，可用值：${servers.join("、")}`);
        const result = await withOperation(async (signal) => {
          const service = await context.client(signal);
          const duplicate = (profiles: Record<string, string>) =>
            Object.values(profiles).some((existing) => existing.trim() === name);
          if (duplicate(await abortable(service.profiles(), signal)))
            throw new Error("已存在同名配置档，请使用其他名称");
          if (context.dryRun) return { dry_run: true, action: "add_config", name, server };
          if (!(await context.approve("add_config", { name, server })))
            throw new Error("操作已取消，未提交到后端");
          signal.throwIfAborted();
          if (duplicate(await abortable(service.profiles(), signal)))
            throw new Error("确认期间出现同名配置档，未提交新建操作");
          const created = await abortable(
            service.request("add_config", undefined, { name, server }),
            signal
          );
          if (
            !created ||
            typeof created.serial !== "string" ||
            !created.serial ||
            created.serial.length > 256
          )
            throw new Error("新建响应缺少配置档 ID，请刷新配置档列表确认结果，避免重复提交");
          const current = await abortable(service.profiles(), signal);
          if (!Object.hasOwn(current, created.serial))
            throw new Error("配置档已提交创建，但尚未载入列表，请刷新查看，避免重复提交");
          if (!values.demo) {
            preferences.profile = created.serial;
            await abortable(saveSettings(preferences, directory), signal);
          }
          context.profile = created.serial;
          return { created: true, profile: created.serial, name, server, result: created };
        });
        ui.result(result);
        break;
      }
      case "run":
        expect(1);
        show("task_run", await action("task_run", { task: args[0] }));
        break;
      case "start":
      case "stop":
        expect(0);
        show(command, await action(command === "start" ? "scheduler_start" : "scheduler_stop"));
        break;
      case "wait":
        expect(0, 1);
        show("wait_run", await action("wait_run", args[0] ? { run_id: args[0] } : {}));
        break;
      case "watch":
        expect(0);
        await withOperation(async (signal) => {
          const service = await context.client(signal);
          const profile = context.profile
            ? await resolveProfile(service, context.profile)
            : undefined;
          streaming = true;
          try {
            await watchStatus(service, { profile, signal, onEvent: monitorEvent });
          } finally {
            streaming = false;
          }
        });
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
            streaming = true;
            try {
              await followLogs(service, { profile, limit, signal, onEvent: monitorEvent });
            } finally {
              streaming = false;
            }
          });
        else show("logs", await action("logs", { limit: args[0] ? Number(args[0]) : 30 }));
        break;
      case "config": {
        const [mode, path = "", ...parts] = args;
        if (mode === "get" && args.length <= 2)
          show("config_get", await action("config_get", { path }));
        else if (mode === "set" && path && parts.length) {
          let value: unknown;
          try {
            value = JSON.parse(parts.join(" "));
          } catch {
            throw new Error("配置值必须是有效 JSON");
          }
          show("config_set", await action("config_set", { path, value }));
        } else throw new Error("用法：config get [/path] 或 config set /path '<JSON>'");
        break;
      }
      case "settings": {
        const [operation = "show", field, value] = args;
        const fields = [
          "url",
          "pipe",
          "profile",
          "packsDirectory",
          "language",
          "connectionMode",
        ] as const;
        if (operation === "show" && args.length <= 1) {
          ui.result({
            path: join(directory, "settings.json"),
            saved: preferences,
            effective: settings,
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
        if (field === "packsDirectory" && next) next = resolve(next);
        if (
          field === "language" &&
          next &&
          !["zh", "en", "ja", "ko", "de", "fr", "ru"].includes(next)
        )
          throw new Error("不支持的界面语言");
        if (field === "connectionMode" && next && !["local", "remote"].includes(next))
          throw new Error("连接模式必须是 local 或 remote");
        const saved = { ...preferences, [field]: next };
        if (field === "url") saved.pipe = undefined;
        await saveSettings(saved, directory);
        ui.result({ saved: join(directory, "settings.json"), field, value: next ?? null });
        break;
      }
      case "reload": {
        expect(0);
        packs = await loadPacks(settings.packsDirectory || join(directory, "commands"));
        packCommands = packs.flatMap((pack) =>
          pack.commands.map((item) => ({ ...item, pack: pack.id }))
        );
        ui.result({ packs: packs.length, commands: packCommands.length });
        break;
      }
      case "packs":
        expect(0);
        ui.result(packs);
        break;
      case "pack": {
        expect(1);
        const pack = packCommands.find((item) => item.name === args[0]);
        if (!pack) throw new Error(`指令包命令不存在：${args[0]}`);
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
              await prepareConfigurationChange(
                service,
                profile,
                String(step.args.path),
                step.args.value,
                context.language
              );
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
          if (state?.accepted === false && state.reason === "already-running")
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
          return execute(["pack", command, ...args]);
        throw new Error(`未知命令：${command}；使用 baasx --help 查看命令`);
    }
  };
  try {
    await execute(options.positionals);
  } catch (error) {
    if (ownedRuntime && error instanceof MonitorError && error.code === "wait_timeout")
      throw new MonitorError(
        "wait_timeout",
        "等待超时；本 CLI 已停止本次自有后端，任务不会在该后端继续执行。",
        {
          owned_backend_stopped: true,
          ...(error.details === undefined ? {} : { original: error.details }),
        }
      );
    if (ownedRuntime && (error as Error).name === "AbortError")
      throw new DOMException(
        "操作已取消；本 CLI 已停止本次自有后端，任务不会在该后端继续执行。",
        "AbortError"
      );
    throw error;
  } finally {
    client?.close();
    ownedRuntime?.close();
    process.removeListener("SIGINT", onSignal);
  }
}

main().catch((error) => {
  const safe = createRedactor([process.env.BAAS_KEY]);
  const message = safe.text((error as Error).message);
  const details =
    error instanceof MonitorError
      ? {
          code: error.code,
          ...(error.details !== undefined ? { details: safe.value(error.details) } : {}),
        }
      : {};
  if (process.argv.includes("--json"))
    process.stdout.write(`${JSON.stringify({ error: message, ...details })}\n`);
  else process.stderr.write(`\n  ! ${terminalText(message)}\n`);
  process.exitCode =
    process.exitCode === 130 || (error as Error).name === "AbortError"
      ? 130
      : error instanceof MonitorError && error.code === "wait_timeout"
        ? 124
        : 1;
});
