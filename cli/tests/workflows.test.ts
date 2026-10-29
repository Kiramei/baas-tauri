import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSession, SessionStore } from "../src/sessions";
import { saveSettings } from "../src/settings";

const temporary: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "baas-workflows-"));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function cli(
  root: string,
  args: string[],
  environment: Record<string, string | undefined> = {}
) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("BAAS_")) delete env[key];
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../src/index.ts"),
      "--config-home",
      root,
      "--json",
      ...args,
    ],
    {
      env: { ...env, ...environment },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error(`CLI workflow hung: ${args.join(" ")}`));
        }, 4000);
      }),
    ]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(stdout).not.toContain("\x1b");
    return { data: JSON.parse(lines[0]) as Record<string, any>, stdout, stderr, code };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}

async function pack(root: string, name: string, steps: unknown[]) {
  await mkdir(join(root, "commands"), { recursive: true });
  await writeFile(
    join(root, "commands", "workflow.json"),
    JSON.stringify({
      id: "workflow-checks",
      name: "流程测试",
      description: "验证执行边界",
      version: 1,
      commands: [{ name, description: "验证计划", steps }],
    })
  );
}

describe("complete CLI workflows", () => {
  test("demo task wait returns correlated completion with one JSON result", async () => {
    const result = await cli(await directory(), [
      "--demo",
      "--yes",
      "--wait",
      "--follow",
      "run",
      "collect_reward",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.data).toMatchObject({
      accepted: true,
      completed: true,
      succeeded: true,
      profile: "sensei-cn",
      status: { running: false, exit_code: 0 },
    });
    expect(result.data.run_id).toBeTypeOf("string");
    expect(result.data.status.run_id).toBe(result.data.run_id);
    expect(result.data.submission.run_id).toBe(result.data.run_id);
  });

  test("demo scheduler wait times out with exit 124 and never reports success", async () => {
    const result = await cli(await directory(), [
      "--demo",
      "--yes",
      "--wait",
      "--wait-timeout",
      "1",
      "start",
    ]);
    expect(result.code).toBe(124);
    expect(result.data.code).toBe("wait_timeout");
    expect(result.data.error).toContain("等待超时");
    expect(result.data.completed).toBeUndefined();
    expect(result.data.succeeded).toBeUndefined();
  });

  test("dry-run packs preview every validated step without submitting or waiting", async () => {
    const root = await directory();
    const result = await cli(root, ["--demo", "--dry-run", "pack", "daily-wait"]);
    expect(result.code).toBe(0);
    expect(result.data).toMatchObject({ dry_run: true, command: "daily-wait", pack: "baas-core" });
    expect(result.data.steps.map((step: { action: string }) => step.action)).toEqual([
      "scheduler_start",
      "wait_run",
    ]);
    expect(result.data.results).toBeUndefined();
    expect(result.stdout).not.toContain('"accepted":true');
    expect(result.stderr).toBe("");
    expect((await readdir(root)).includes("sessions")).toBe(false);
  });

  test("read-only preflight rejects a mixed pack before any step output", async () => {
    const root = await directory();
    await pack(root, "mixed-plan", [
      { action: "status", args: {} },
      { action: "scheduler_start", args: {} },
    ]);
    const result = await cli(root, ["--demo", "--read-only", "pack", "mixed-plan"]);
    expect(result.code).toBe(1);
    expect(result.data.error).toContain("只读");
    expect(result.data.error).toContain("未执行任何步骤");
    expect(result.data.results).toBeUndefined();
    expect(result.stderr).toBe("");
  });

  test("a later unknown task fails whole-plan preflight before an earlier mutation", async () => {
    const root = await directory();
    await pack(root, "invalid-later-task", [
      { action: "scheduler_start", args: {} },
      { action: "task_run", args: { task: "invented_task" } },
    ]);
    const result = await cli(root, ["--demo", "--yes", "pack", "invalid-later-task"]);
    expect(result.code).toBe(1);
    expect(result.data.error).toContain("任务不存在");
    expect(result.data.error).toContain("未执行任何步骤");
    expect(result.stderr).toBe("");
  });

  test("settings set/unset preserve saved preferences independently of environment overrides", async () => {
    const root = await directory();
    await saveSettings(
      { url: "ws://saved.invalid:8190", profile: "saved-profile", model: "saved-model" },
      root
    );
    const environment = {
      BAAS_SERVER: "ws://environment.invalid:8190",
      BAAS_PROFILE: "environment-profile",
      BAAS_AI_MODEL: "environment-model",
      BAAS_KEY: "must-not-persist",
      BAAS_AI_API_KEY: "model-key-not-persisted",
    };
    const shown = await cli(root, ["settings", "show"], environment);
    expect(shown.data.saved).toMatchObject({
      url: "ws://saved.invalid:8190",
      profile: "saved-profile",
      model: "saved-model",
    });
    expect(shown.data.effective).toMatchObject({
      url: "ws://environment.invalid:8190",
      profile: "environment-profile",
    });
    expect(shown.data.model).toBe("environment-model");
    expect(
      (await cli(root, ["settings", "set", "model", "new-saved-model"], environment)).code
    ).toBe(0);
    const disk = await readFile(join(root, "settings.json"), "utf8");
    expect(JSON.parse(disk)).toEqual({
      url: "ws://saved.invalid:8190",
      profile: "saved-profile",
      model: "new-saved-model",
    });
    expect(disk).not.toContain("environment");
    expect(disk).not.toContain("must-not-persist");
    expect(disk).not.toContain("model-key-not-persisted");
    expect((await cli(root, ["settings", "unset", "model"], environment)).code).toBe(0);
    expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual({
      url: "ws://saved.invalid:8190",
      profile: "saved-profile",
    });
  });

  test("resume rejects endpoint and explicit profile mismatches", async () => {
    const root = await directory();
    const store = new SessionStore(root);
    const remote = newSession("ws://other.invalid:8190", "sensei-cn");
    await store.save(remote);
    const differentEndpoint = await cli(root, ["--demo", "--resume", remote.id, "status"]);
    expect(differentEndpoint.code).toBe(1);
    expect(differentEndpoint.data.error).toContain("另一后端");

    const demo = newSession("demo", "sensei-cn", "remembered-model");
    demo.messages = [
      { role: "user", content: "检查配置" },
      { role: "assistant", content: "好的" },
    ];
    await store.save(demo);
    const differentProfile = await cli(root, [
      "--demo",
      "--profile",
      "sensei-jp",
      "--resume",
      demo.id,
      "status",
    ]);
    expect(differentProfile.code).toBe(1);
    expect(differentProfile.data.error).toContain("配置档不同");
    const matched = await cli(root, ["--demo", "--profile", "sensei-cn", "resume", demo.id]);
    expect(matched.code).toBe(0);
    expect(matched.data).toMatchObject({
      session_id: demo.id,
      profile: "sensei-cn",
      messages: 2,
      model: "remembered-model",
    });
  });

  test("no-session conflicts are explicit for both startup flags and resume commands", async () => {
    const root = await directory();
    const conflict = await cli(root, ["--demo", "--no-session", "--resume", "latest", "status"]);
    expect(conflict.code).toBe(1);
    expect(conflict.data.error).toContain("不能同时使用");
    const command = await cli(root, ["--demo", "--no-session", "resume", "latest"]);
    expect(command.code).toBe(1);
    expect(command.data.error).toContain("不能恢复会话");
  });

  test("invalid commands, option values and extra positional arguments exit nonzero", async () => {
    const root = await directory();
    for (const args of [
      ["--demo", "unknown-command"],
      ["--demo", "status", "extra"],
      ["--demo", "run"],
      ["--demo", "--yes", "run", "invented-task"],
      ["--wait-timeout", "0", "status"],
      ["--unknown-option", "status"],
      ["settings", "set", "apiKey", "no"],
      ["settings", "show", "extra"],
      ["settings", "set", "aiBaseUrl", "https://user:secret@example.invalid/v1"],
    ]) {
      const result = await cli(root, args);
      expect(result.code).toBe(1);
      expect(result.data.error).toBeTypeOf("string");
      expect(result.data.error.length).toBeGreaterThan(0);
    }
  });
});
