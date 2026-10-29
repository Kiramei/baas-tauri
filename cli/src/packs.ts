import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const PACK_ACTIONS = [
  "status",
  "profiles",
  "tasks",
  "config_get",
  "config_set",
  "scheduler_start",
  "scheduler_stop",
  "task_run",
  "devices",
  "logs",
  "wait_run",
] as const;
export type PackAction = (typeof PACK_ACTIONS)[number];
export interface CommandStep {
  action: PackAction;
  args: Record<string, unknown>;
}
export interface PackCommand {
  name: string;
  description: string;
  steps: CommandStep[];
}
export interface CommandPack {
  id: string;
  name: string;
  description: string;
  version: 1;
  commands: PackCommand[];
}

const CORE_NAMES = new Set([
  "home",
  "language",
  "setup",
  "install",
  "local",
  "new-profile",
  "profile",
  "help",
  "quit",
  "exit",
  "connect",
  "status",
  "profiles",
  "use",
  "tasks",
  "config",
  "run",
  "start",
  "stop",
  "logs",
  "doctor",
  "devices",
  "packs",
  "pack",
  "agent",
  "model",
  "clear",
  "login",
  "logout",
  "settings",
  "init",
  "wait",
  "watch",
  "models",
  "sessions",
  "resume",
  "new",
  "context",
  "reload",
]);
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
// eslint-disable-next-line no-control-regex -- Pack metadata and argument text cannot contain terminal controls.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const PROFILE_ACTIONS: readonly PackAction[] = [
  "tasks",
  "config_get",
  "config_set",
  "scheduler_start",
  "scheduler_stop",
  "task_run",
  "logs",
  "wait_run",
];

const BUILTIN_PACK: CommandPack = {
  id: "baas-core",
  name: "BAAS 日常工作台",
  description: "独立 CLI 指令包：查看服务与配置档状态，或启动当前配置档的已有调度。",
  version: 1,
  commands: [
    {
      name: "briefing",
      description: "查看服务状态和当前配置档的任务安排。",
      steps: [
        { action: "status", args: {} },
        { action: "tasks", args: {} },
      ],
    },
    {
      name: "connection-check",
      description: "查看服务状态与设备列表，不启动游戏任务。",
      steps: [
        { action: "status", args: {} },
        { action: "devices", args: {} },
      ],
    },
    {
      name: "daily",
      description: "启动当前配置档的已有调度；启动确认不代表任务已完成。",
      steps: [{ action: "scheduler_start", args: {} }],
    },
    {
      name: "daily-wait",
      description: "启动当前配置档的已有调度，并等待本次运行最多 120 秒；超时不代表运行已结束。",
      steps: [
        { action: "scheduler_start", args: {} },
        { action: "wait_run", args: { timeout_seconds: 120 } },
      ],
    },
  ],
};

function record(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function fail(path: string, message: string): never {
  throw new Error(`指令包 ${path}: ${message}`);
}
function text(value: unknown, path: string, limit = 240): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > limit ||
    CONTROL_CHARACTERS.test(value)
  )
    fail(path, `应为 1–${limit} 个字符的无控制字符文本`);
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${path}.${key}`, `未知字段；允许 ${allowed.join(", ")}`);
}

function jsonValue(value: unknown, path: string, depth = 0, seen = new Set<object>()): unknown {
  if (depth > 24) fail(path, "配置值嵌套超过 24 层");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) fail(path, "值必须是有效 JSON");
  if (seen.has(value)) fail(path, "值不能包含循环引用");
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value))
    result = value.map((item, index) => jsonValue(item, `${path}[${index}]`, depth + 1, seen));
  else if (record(value))
    result = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        jsonValue(item, `${path}.${key}`, depth + 1, seen),
      ])
    );
  else fail(path, "值必须是普通 JSON 对象");
  seen.delete(value);
  return result;
}

function validateStep(value: unknown, path: string): CommandStep {
  if (!record(value)) fail(path, "步骤必须是对象");
  keys(value, ["action", "args"], path);
  if (typeof value.action !== "string" || !PACK_ACTIONS.includes(value.action as PackAction))
    fail(`${path}.action`, `不支持此操作；允许 ${PACK_ACTIONS.join(", ")}`);
  const action = value.action as PackAction;
  if (!record(value.args)) fail(`${path}.args`, "参数必须是对象");
  const args = value.args;
  const allowed = PROFILE_ACTIONS.includes(action) ? ["profile"] : [];
  if (action === "config_get") allowed.push("path");
  if (action === "config_set") allowed.push("path", "value");
  if (action === "task_run") allowed.push("task");
  if (action === "logs") allowed.push("limit");
  if (action === "wait_run") allowed.push("run_id", "timeout_seconds");
  keys(args, allowed, `${path}.args`);
  const result: Record<string, unknown> = {};
  if (Object.hasOwn(args, "profile"))
    result.profile = text(args.profile, `${path}.args.profile`, 128);
  if (Object.hasOwn(args, "run_id")) result.run_id = text(args.run_id, `${path}.args.run_id`, 128);
  if (Object.hasOwn(args, "timeout_seconds")) {
    if (
      typeof args.timeout_seconds !== "number" ||
      !Number.isInteger(args.timeout_seconds) ||
      args.timeout_seconds < 1 ||
      args.timeout_seconds > 120
    )
      fail(`${path}.args.timeout_seconds`, "应为 1–120 的整数");
    result.timeout_seconds = args.timeout_seconds;
  }
  if (Object.hasOwn(args, "path") || action === "config_set") {
    if (
      typeof args.path !== "string" ||
      (args.path !== "" && !args.path.startsWith("/")) ||
      /~(?![01])/u.test(args.path) ||
      CONTROL_CHARACTERS.test(args.path)
    )
      fail(`${path}.args.path`, "应为有效 JSON Pointer，例如 /name；根路径为空字符串");
    result.path = args.path;
  }
  if (action === "config_set") {
    if (!Object.hasOwn(args, "value")) fail(`${path}.args.value`, "缺少配置值");
    result.value = jsonValue(args.value, `${path}.args.value`);
  }
  if (action === "task_run") result.task = text(args.task, `${path}.args.task`, 128);
  if (Object.hasOwn(args, "limit")) {
    if (
      typeof args.limit !== "number" ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 500
    )
      fail(`${path}.args.limit`, "应为 1–500 的整数");
    result.limit = args.limit;
  }
  return { action, args: result };
}

/** Parse declarative BAAS operations only. No scripts, shell commands or module imports. */
export function validatePack(data: unknown): CommandPack {
  if (!record(data)) fail("$", "根节点必须是对象");
  keys(data, ["id", "name", "description", "version", "commands"], "$");
  if (typeof data.id !== "string" || !NAME.test(data.id))
    fail("$.id", "应为小写字母开头、最多 64 个字符的字母/数字/连字符标识");
  if (data.version !== 1) fail("$.version", "目前仅支持版本 1");
  const name = text(data.name, "$.name", 120);
  const description = text(data.description, "$.description", 500);
  if (!Array.isArray(data.commands) || !data.commands.length || data.commands.length > 100)
    fail("$.commands", "应包含 1–100 条指令");
  const names = new Set<string>();
  const commands = data.commands.map((command, index): PackCommand => {
    const path = `$.commands[${index}]`;
    if (!record(command)) fail(path, "指令必须是对象");
    keys(command, ["name", "description", "steps"], path);
    if (typeof command.name !== "string" || !NAME.test(command.name))
      fail(`${path}.name`, "应为小写字母开头、最多 64 个字符的字母/数字/连字符指令名，不含 / 前缀");
    if (CORE_NAMES.has(command.name)) fail(`${path}.name`, `/${command.name} 与 CLI 内置指令冲突`);
    if (names.has(command.name)) fail(`${path}.name`, `重复指令 /${command.name}`);
    names.add(command.name);
    if (!Array.isArray(command.steps) || !command.steps.length || command.steps.length > 50)
      fail(`${path}.steps`, "应包含 1–50 个步骤");
    return {
      name: command.name,
      description: text(command.description, `${path}.description`, 500),
      steps: command.steps.map((step, stepIndex) =>
        validateStep(step, `${path}.steps[${stepIndex}]`)
      ),
    };
  });
  return { id: data.id, name, description, version: 1, commands };
}

/** Builtins are embedded so compiled binaries work without locating loose assets. */
export async function loadPacks(directory?: string): Promise<CommandPack[]> {
  const packs = [validatePack(BUILTIN_PACK)];
  if (!directory) return packs;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return packs;
    throw new Error(`无法读取指令包目录 ${directory}: ${(error as Error).message}`);
  }
  const ids = new Map(packs.map((pack) => [pack.id, "内置指令包"]));
  const commands = new Map(
    packs.flatMap((pack) => pack.commands.map((command) => [command.name, pack.id] as const))
  );
  for (const entry of entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = join(directory, entry.name);
    let pack: CommandPack;
    try {
      const source = await readFile(filename, "utf8");
      if (source.length > 1024 * 1024) throw new Error("文件超过 1 MiB");
      pack = validatePack(JSON.parse(source));
    } catch (error) {
      throw new Error(`无法加载指令包 ${filename}: ${(error as Error).message}`);
    }
    if (ids.has(pack.id))
      throw new Error(`指令包 ${filename}: ID ${pack.id} 与 ${ids.get(pack.id)} 冲突`);
    for (const command of pack.commands) {
      if (commands.has(command.name))
        throw new Error(
          `指令包 ${filename}: /${command.name} 已由 ${commands.get(command.name)} 定义`
        );
    }
    ids.set(pack.id, filename);
    pack.commands.forEach((command) => commands.set(command.name, pack.id));
    packs.push(pack);
  }
  return packs;
}
