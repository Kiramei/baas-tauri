import type { BaasClient } from "@baas/client";
import type { DemoClient } from "./demo";
import Ajv from "ajv";
import { waitForRun, type MonitorEvent } from "./monitor";
import { validateConfigurationStoredValue } from "./configuration";
import { validateNewEventState } from "./scheduler";

export interface ActionDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutating: boolean;
}

export type Client =
  | Pick<
      BaasClient,
      | "connect"
      | "close"
      | "profiles"
      | "status"
      | "config"
      | "staticData"
      | "tasks"
      | "logs"
      | "request"
      | "patchConfig"
      | "onStatus"
      | "onDisconnect"
      | "onLog"
      | "statusSnapshot"
    >
  | DemoClient;
export interface ActionContext {
  client: (signal?: AbortSignal) => Promise<Client>;
  profile?: string;
  readOnly: boolean;
  approve: (name: string, args: Record<string, unknown>) => Promise<boolean>;
  signal?: AbortSignal;
  dryRun?: boolean;
  wait?: boolean;
  waitTimeoutMs?: number;
  follow?: boolean;
  lastRun?: { profile: string; run_id: string };
  onEvent?: (event: MonitorEvent) => void;
  approvalBaselines?: Map<string, unknown>;
  language?: string;
}

const profile = {
  type: "string",
  description: "配置档的精确 ID 或唯一名称；省略时使用当前选中的配置档",
};
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const waiting = {
  wait: { type: "boolean" },
  timeout_seconds: { type: "integer", minimum: 1, maximum: 120 },
};
export const ACTIONS: ActionDefinition[] = [
  {
    name: "status",
    description: "读取所有 BAAS 配置档的运行状态。running 表示执行中；启动被接受不代表完成。",
    inputSchema: object({}),
    mutating: false,
  },
  {
    name: "profiles",
    description: "列出配置档 ID 与名称。选择配置档必须明确匹配，不猜测账号。",
    inputSchema: object({}),
    mutating: false,
  },
  {
    name: "tasks",
    description: "读取配置档已配置的真实任务及调度设置，执行前用它核对任务名。",
    inputSchema: object({ profile }),
    mutating: false,
  },
  {
    name: "config_get",
    description:
      "读取配置档配置；path 是可选 JSON Pointer，如 /name。数据可能含敏感配置，请仅按需读取。",
    inputSchema: object({ profile, path: { type: "string" } }),
    mutating: false,
  },
  {
    name: "config_set",
    description:
      "修改一个已有配置字段。使用 JSON Pointer，原子冲突会报错，不自动覆盖其他客户端的修改。",
    inputSchema: object({ profile, path: { type: "string", minLength: 1 }, value: {} }, [
      "path",
      "value",
    ]),
    mutating: true,
  },
  {
    name: "scheduler_start",
    description:
      "启动此配置档现有调度。返回 accepted/started 仅表示启动已接受，需要再读 status/logs 观察运行。",
    inputSchema: object({ profile, ...waiting }),
    mutating: true,
  },
  {
    name: "scheduler_stop",
    description: "停止选中配置档的调度或单任务。",
    inputSchema: object({ profile, ...waiting }),
    mutating: true,
  },
  {
    name: "task_run",
    description:
      "向 BAAS 提交一个实际配置的任务，task 必须来自 tasks 的键名。返回接受不代表任务完成。",
    inputSchema: object({ profile, task: { type: "string", minLength: 1 }, ...waiting }, ["task"]),
    mutating: true,
  },
  {
    name: "wait_run",
    description:
      "等待指定运行编号结束，不会提交或重复启动任务。可等待当前配置档最近一次明确提交的运行，最多等待 120 秒；返回 completed 与 succeeded 的真实状态。",
    inputSchema: object({
      profile,
      run_id: { type: "string", minLength: 1 },
      timeout_seconds: { type: "integer", minimum: 1, maximum: 120 },
    }),
    mutating: false,
  },
  {
    name: "devices",
    description: "通过后端 ADB 检测可连接设备，返回设备地址。",
    inputSchema: object({}),
    mutating: false,
  },
  {
    name: "logs",
    description: "读取最近的运行日志，支持配置档过滤。",
    inputSchema: object({ profile, limit: { type: "integer", minimum: 1, maximum: 500 } }),
    mutating: false,
  },
];
const ajv = new Ajv({ allErrors: true, ownProperties: true });
const validators = new Map(ACTIONS.map((action) => [action.name, ajv.compile(action.inputSchema)]));

export function validateAction(name: string, args: Record<string, unknown>) {
  const action = ACTIONS.find((item) => item.name === name);
  if (!action) throw new Error(`未知 BAAS 动作：${name}`);
  const validate = validators.get(name)!;
  if (!validate(args)) {
    const extra = validate.errors?.find((error) => error.keyword === "additionalProperties");
    if (extra) throw new Error(`动作 ${name} 不接受参数 ${extra.params.additionalProperty}`);
    const missing = validate.errors?.find((error) => error.keyword === "required");
    if (missing) throw new Error(`动作 ${name} 缺少参数 ${missing.params.missingProperty}`);
    const field = validate.errors?.[0]?.instancePath.slice(1);
    const rule = (action.inputSchema.properties as Record<string, Record<string, unknown>>)[
      field || ""
    ];
    if (rule?.type === "integer")
      throw new Error(`参数 ${field} 必须是 ${rule.minimum}–${rule.maximum} 的整数`);
    throw new Error(
      `动作 ${name} 参数无效：${ajv.errorsText(validate.errors, { dataVar: "参数" })}`
    );
  }
  return action;
}

export function readPointer(data: unknown, path: string): unknown {
  if (!path) return data;
  if (!path.startsWith("/") || /~(?![01])/.test(path))
    throw new Error("配置路径必须是 JSON Pointer，例如 /name 或 /control_method");
  let value = data;
  for (const part of path
    .slice(1)
    .split("/")
    .map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part))
      throw new Error(`配置路径不存在：${path}`);
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export async function resolveProfile(client: Client, requested?: string): Promise<string> {
  if (!requested)
    throw new Error("请先用 /profiles 查看配置档，再用 /use <ID> 选择，或传入 --profile <ID>");
  const profiles = await client.profiles();
  if (Object.hasOwn(profiles, requested)) return requested;
  const matches = Object.entries(profiles).filter(([, name]) => name === requested);
  if (matches.length === 1) return matches[0][0];
  if (matches.length > 1) throw new Error(`配置档名称重复，请使用精确 ID：${requested}`);
  throw new Error(`配置档不存在：${requested}`);
}

/** Shared typed configuration validation for commands, workspace controls and full pack preflight. */
export async function prepareConfigurationChange(
  client: Client,
  profile: string,
  path: string,
  value: unknown,
  language?: string
): Promise<{ before: unknown; value: unknown }> {
  if (
    !path.startsWith("/") ||
    path
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
      .some((part) => ["__proto__", "constructor", "prototype"].includes(part))
  )
    throw new Error("无效或不支持的配置路径");
  const config = await client.config(profile);
  const before = structuredClone(readPointer(config, path));
  return {
    before,
    value:
      path === "/new_event_enable_state"
        ? validateNewEventState(value)
        : validateConfigurationStoredValue(config, path, value, {
            language,
            staticData: await client.staticData(),
          }),
  };
}

/** Terminal commands, workspace controls and command packs share this boundary. */
export async function executeAction(
  name: string,
  args: Record<string, unknown>,
  context: ActionContext,
  approved = false
): Promise<unknown> {
  context.signal?.throwIfAborted();
  const action = validateAction(name, args);
  if (action.mutating && context.readOnly)
    throw new Error("当前为只读模式，不能执行改变状态的动作");
  const client = await context.client(context.signal);
  context.signal?.throwIfAborted();
  const needsProfile =
    !["status", "profiles", "devices"].includes(name) &&
    (name !== "logs" || args.profile || context.profile);
  const selected = needsProfile
    ? await resolveProfile(client, String(args.profile ?? context.profile ?? ""))
    : undefined;
  context.signal?.throwIfAborted();
  let effectiveArgs = selected ? { ...args, profile: selected } : args;
  let before: unknown;
  if (action.mutating) {
    if (name === "config_set") {
      const path = String(args.path);
      const prepared = await prepareConfigurationChange(
        client,
        selected!,
        path,
        args.value,
        context.language
      );
      context.signal?.throwIfAborted();
      args = { ...args, value: prepared.value };
      effectiveArgs = { ...effectiveArgs, value: prepared.value };
      const baselineKey = `${selected}\0${path}`;
      before = context.approvalBaselines?.has(baselineKey)
        ? context.approvalBaselines.get(baselineKey)
        : prepared.before;
      context.approvalBaselines?.delete(baselineKey);
    }
    if (name === "task_run") {
      const tasks = await client.tasks(selected!);
      if (!Object.hasOwn(tasks, String(args.task)))
        throw new Error(`任务不存在：${String(args.task)}；请先查看 /tasks`);
    }
    if (context.dryRun)
      return {
        dry_run: true,
        action: name,
        ...effectiveArgs,
        ...(name === "config_set" ? { before, after: args.value } : {}),
      };
    if (
      !approved &&
      !(await context.approve(name, {
        ...effectiveArgs,
        ...(name === "config_set" ? { before } : {}),
      }))
    )
      throw new Error("操作已取消，未提交到后端");
  }
  context.signal?.throwIfAborted();
  switch (name) {
    case "profiles":
      return client.profiles();
    case "status":
      return client.status();
    case "devices":
      return client.request("detect_adb");
    case "tasks":
      return client.tasks(selected!);
    case "config_get":
      return readPointer(await client.config(selected!), String(args.path ?? ""));
    case "config_set": {
      // Conditions and catalogs can change while approval is open. Check them again
      // before the client's field-level CAS; the original field value remains the baseline.
      const prepared = await prepareConfigurationChange(
        client,
        selected!,
        String(args.path),
        args.value,
        context.language
      );
      context.signal?.throwIfAborted();
      return client.patchConfig(selected!, String(args.path), prepared.value, {
        checkExpected: true,
        expectedValue: before,
      });
    }
    case "scheduler_stop": {
      const result = await client.request("stop_scheduler", selected!);
      if (
        (context.wait || args.wait === true) &&
        result?.status === "stopping" &&
        typeof result.run_id === "string"
      )
        return waitForRun(client, selected!, {
          runId: result.run_id,
          timeoutMs: args.timeout_seconds
            ? Number(args.timeout_seconds) * 1000
            : context.waitTimeoutMs,
          signal: context.signal,
          followLogs: context.follow,
          onEvent: context.onEvent,
        });
      return result;
    }
    case "scheduler_start":
    case "task_run": {
      const submit = async () => {
        context.signal?.throwIfAborted();
        const result = await client.request(
          name === "task_run" ? "solve" : "start_scheduler",
          selected!,
          name === "task_run" ? { task: args.task } : {}
        );
        if (result?.status !== "already-running" && typeof result?.run_id === "string")
          context.lastRun = { profile: selected!, run_id: result.run_id };
        return result;
      };
      if (args.wait === true || context.wait)
        return waitForRun(client, selected!, {
          submit,
          timeoutMs: args.timeout_seconds
            ? Number(args.timeout_seconds) * 1000
            : context.waitTimeoutMs,
          followLogs: context.follow,
          signal: context.signal,
          onEvent: context.onEvent,
        });
      const result = await submit();
      return {
        accepted: result?.status !== "already-running",
        completed: false,
        run_id: result?.run_id ?? null,
        ...(result?.status === "already-running" ? { reason: "already-running" } : {}),
        result,
      };
    }
    case "wait_run":
      return waitForRun(client, selected!, {
        runId:
          typeof args.run_id === "string"
            ? args.run_id
            : context.lastRun && context.lastRun.profile === selected
              ? context.lastRun.run_id
              : undefined,
        timeoutMs: args.timeout_seconds
          ? Number(args.timeout_seconds) * 1000
          : context.waitTimeoutMs,
        followLogs: context.follow,
        signal: context.signal,
        onEvent: context.onEvent,
      });
    case "logs":
      return client.logs(Number(args.limit ?? 30), selected);
  }
}
