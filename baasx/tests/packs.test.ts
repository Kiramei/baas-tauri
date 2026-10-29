import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPacks, validatePack } from "../src/packs.ts";

const temporary: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "baas-packs-"));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function custom(overrides: Record<string, unknown> = {}) {
  return {
    id: "sensei-tools",
    name: "老师的工具",
    description: "自定义 BAAS 状态检查",
    version: 1,
    commands: [
      {
        name: "morning-check",
        description: "检查配置档",
        steps: [{ action: "tasks", args: { profile: "main" } }],
      },
    ],
    ...overrides,
  };
}

describe("declarative BAAS command packs", () => {
  test("embedded builtins need no files and daily only starts the existing scheduler", async () => {
    const [pack] = await loadPacks();
    expect(pack.id).toBe("baas-core");
    expect(pack.commands.find((command) => command.name === "daily")?.steps).toEqual([
      { action: "scheduler_start", args: {} },
    ]);
    expect(pack.commands.find((command) => command.name === "daily")?.description).toContain(
      "不代表任务已完成"
    );
    expect(
      pack.commands.find((command) => command.name === "briefing")?.steps.map((step) => step.action)
    ).toEqual(["status", "tasks"]);
  });

  test("editable builtin JSON matches embedded definitions", async () => {
    const [pack] = await loadPacks();
    expect(
      validatePack(
        JSON.parse(await readFile(new URL("../packs/baas-core.json", import.meta.url), "utf8"))
      )
    ).toEqual(pack);
  });

  test("daily-wait follows scheduler acceptance with an explicit bounded wait", async () => {
    const [pack] = await loadPacks();
    expect(pack.commands.find((command) => command.name === "daily-wait")?.steps).toEqual([
      { action: "scheduler_start", args: {} },
      { action: "wait_run", args: { timeout_seconds: 120 } },
    ]);
  });

  test.each([
    "wait",
    "watch",
    "models",
    "sessions",
    "resume",
    "new",
    "context",
    "settings",
    "reload",
  ])("reserves core command /%s", (name) => {
    expect(() =>
      validatePack(
        custom({
          commands: [{ name, description: "collision", steps: [{ action: "status", args: {} }] }],
        })
      )
    ).toThrow("CLI 内置指令冲突");
  });

  test("wait_run accepts only its read-only correlation and timeout arguments", () => {
    const pack = (args: Record<string, unknown>) =>
      custom({
        commands: [
          {
            name: "await-current",
            description: "等待本次运行",
            steps: [{ action: "wait_run", args }],
          },
        ],
      });
    expect(validatePack(pack({})).commands[0].steps[0]).toEqual({ action: "wait_run", args: {} });
    const args = { profile: "main", run_id: "run-123", timeout_seconds: 1 };
    expect(validatePack(pack(args)).commands[0].steps[0].args).toEqual(args);
    expect(
      validatePack(pack({ timeout_seconds: 120 })).commands[0].steps[0].args.timeout_seconds
    ).toBe(120);
    for (const value of [0, 121, 1.5, "20", null, NaN, Infinity])
      expect(() => validatePack(pack({ timeout_seconds: value }))).toThrow("1–120");
    for (const value of ["", "\x1b[2J", 42, "x".repeat(129)])
      expect(() => validatePack(pack({ run_id: value }))).toThrow("args.run_id");
    expect(() => validatePack(pack({ shell: "echo no" }))).toThrow("未知字段");
    expect(() => validatePack(pack({ task: "arena" }))).toThrow("未知字段");
  });

  test("loads independent local packs and tolerates a missing optional directory", async () => {
    const path = await directory();
    await writeFile(join(path, "sensei.json"), JSON.stringify(custom()));
    await writeFile(join(path, "notes.txt"), "not a pack");
    expect((await loadPacks(path)).map((pack) => pack.id)).toEqual(["baas-core", "sensei-tools"]);
    expect((await loadPacks(join(path, "not-created"))).length).toBe(1);
  });

  test("rejects shell/code execution and unknown action arguments", () => {
    const pack = custom();
    pack.commands[0].steps = [{ action: "shell", args: { profile: "main" } }];
    expect(() => validatePack(pack)).toThrow("不支持此操作");
    expect(() => validatePack(custom({ script: "rm -rf /" }))).toThrow("未知字段");
    const bad = custom();
    bad.commands[0].steps[0].args = { profile: "main", shell: "echo surprise" } as {
      profile: string;
    };
    expect(() => validatePack(bad)).toThrow("未知字段");
  });

  test("validates required mutation arguments and JSON Pointer syntax", () => {
    const pack = custom({
      commands: [
        {
          name: "change-name",
          description: "更新配置档名称",
          steps: [
            { action: "config_set", args: { profile: "main", path: "/name", value: "老师" } },
          ],
        },
      ],
    });
    expect(validatePack(pack).commands[0].steps[0].args.value).toBe("老师");
    expect(() =>
      validatePack(
        custom({
          commands: [
            {
              name: "change-name",
              description: "修改",
              steps: [{ action: "config_set", args: { path: "name", value: "老师" } }],
            },
          ],
        })
      )
    ).toThrow("JSON Pointer");
    expect(() =>
      validatePack(
        custom({
          commands: [
            {
              name: "change-name",
              description: "修改",
              steps: [{ action: "config_set", args: { path: "/name" } }],
            },
          ],
        })
      )
    ).toThrow("缺少配置值");
    expect(() =>
      validatePack(
        custom({
          commands: [
            { name: "run-one", description: "运行任务", steps: [{ action: "task_run", args: {} }] },
          ],
        })
      )
    ).toThrow("args.task");
  });

  test("rejects invalid versions, names, log limits and duplicate local commands", () => {
    expect(() => validatePack(custom({ version: 2 }))).toThrow("版本 1");
    expect(() => validatePack(custom({ id: "../outside" }))).toThrow("$.id");
    expect(() =>
      validatePack(
        custom({
          commands: [
            { name: "status", description: "collision", steps: [{ action: "status", args: {} }] },
          ],
        })
      )
    ).toThrow("CLI 内置指令冲突");
    expect(() =>
      validatePack(
        custom({
          commands: [
            {
              name: "my-logs",
              description: "日志",
              steps: [{ action: "logs", args: { limit: -1 } }],
            },
          ],
        })
      )
    ).toThrow("1–500");
    const pack = custom();
    pack.commands.push(pack.commands[0]);
    expect(() => validatePack(pack)).toThrow("重复指令");
  });

  test("reports source filenames for invalid JSON and collisions", async () => {
    const path = await directory();
    await writeFile(join(path, "bad.json"), "not-json");
    await expect(loadPacks(path)).rejects.toThrow("bad.json");
    await rm(join(path, "bad.json"));
    await writeFile(join(path, "one.json"), JSON.stringify(custom()));
    await writeFile(join(path, "two.json"), JSON.stringify(custom({ id: "second-pack" })));
    await expect(loadPacks(path)).rejects.toThrow("morning-check");
    await rm(join(path, "two.json"));
    await writeFile(join(path, "duplicate.json"), JSON.stringify(custom({ id: "baas-core" })));
    await expect(loadPacks(path)).rejects.toThrow("ID baas-core");
  });
});
