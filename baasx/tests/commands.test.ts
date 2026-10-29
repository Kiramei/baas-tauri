import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAction, readPointer, resolveProfile, type ActionContext } from "../src/actions";
import { parseArguments, tokenize } from "../src/arguments";
import { DemoClient } from "../src/demo";
import { loadSettings, normalizeEndpoint, saveSettings } from "../src/settings";

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  const client = new DemoClient();
  return {
    client: async () => client,
    profile: "sensei-cn",
    readOnly: false,
    approve: async () => false,
    ...overrides,
  };
}

describe("shared action capability boundary", () => {
  test("requires an explicit real profile and resolves unique names", async () => {
    const client = new DemoClient();
    expect(await resolveProfile(client, "夏莱 · 国服")).toBe("sensei-cn");
    await expect(resolveProfile(client)).rejects.toThrow("选择");
    await expect(resolveProfile(client, "__proto__")).rejects.toThrow("不存在");
  });
  test("read-only applies to commands and command pack executor even when approved", async () => {
    await expect(
      executeAction("scheduler_start", {}, context({ readOnly: true }), true)
    ).rejects.toThrow("只读");
    await expect(
      executeAction(
        "config_set",
        { path: "/name", value: "changed" },
        context({ readOnly: true }),
        true
      )
    ).rejects.toThrow("只读");
  });
  test("denying mutation leaves backend unchanged", async () => {
    const ctx = context();
    await expect(executeAction("scheduler_start", {}, ctx)).rejects.toThrow("取消");
    expect(((await executeAction("status", {}, ctx)) as any)["sensei-cn"].running).toBe(false);
  });
  test("accepted execution never reports task completion", async () => {
    const ctx = context({ approve: async () => true });
    expect(await executeAction("task_run", { task: "collect_reward" }, ctx)).toMatchObject({
      accepted: true,
      completed: false,
    });
    expect(((await executeAction("status", {}, ctx)) as any)["sensei-cn"].current_task).toBe(
      "collect_reward"
    );
    await executeAction("scheduler_stop", {}, ctx);
    expect(((await executeAction("status", {}, ctx)) as any)["sensei-cn"].running).toBe(false);
  });
  test("unknown task, malformed arguments and dangerous path never run", async () => {
    const ctx = context({ approve: async () => true });
    await expect(executeAction("task_run", { task: "invented" }, ctx)).rejects.toThrow("不存在");
    await expect(executeAction("status", { command: "shell" }, ctx)).rejects.toThrow("不接受");
    await expect(
      executeAction("config_set", { path: "/__proto__/polluted", value: true }, ctx)
    ).rejects.toThrow("路径");
    await expect(executeAction("logs", { limit: 0 }, ctx)).rejects.toThrow("整数");
  });
  test("config updates require an existing desktop-editable field and preserve typed wire values", async () => {
    const ctx = context({ approve: async () => true });
    await executeAction("config_set", { path: "/program_address", value: "/demo/emulator" }, ctx);
    expect(await executeAction("config_get", { path: "/program_address" }, ctx)).toBe(
      "/demo/emulator"
    );
    await executeAction("config_set", { path: "/favorStudent1", value: ["优香", "爱丽丝"] }, ctx);
    expect(await executeAction("config_get", { path: "/favorStudent1" }, ctx)).toEqual([
      "优香",
      "爱丽丝",
    ]);
    await expect(
      executeAction("config_set", { path: "/server", value: "日服" }, ctx)
    ).rejects.toThrow();
    await expect(
      executeAction("config_set", { path: "/name", value: "unsupported" }, ctx)
    ).rejects.toThrow();
    await expect(
      executeAction("config_set", { path: "/cafe_reward_affection_pat_round", value: 100 }, ctx)
    ).rejects.toThrow();
    expect(
      await executeAction("config_get", { path: "/cafe_reward_affection_pat_round" }, ctx)
    ).toBe(5);
    await expect(
      executeAction("config_set", { path: "/missing", value: true }, ctx)
    ).rejects.toThrow("不存在");
    expect(readPointer({ "a/b": { "~": 3 } }, "/a~1b/~0")).toBe(3);
  });
  test("configuration conditions are rechecked after approval before any write", async () => {
    const client = new DemoClient();
    const ctx = context({
      client: async () => client,
      approve: async () => {
        await client.patchConfig("sensei-cn", "/cafe_reward_invite1_criterion", "lowest_affection");
        return true;
      },
    });
    await expect(
      executeAction("config_set", { path: "/favorStudent1", value: ["优香"] }, ctx)
    ).rejects.toThrow();
    expect((await client.config("sensei-cn")).favorStudent1).toEqual(["爱丽丝"]);
    expect(
      (await client.logs()).filter((entry) => entry.message.includes("favorStudent1"))
    ).toHaveLength(0);
  });
});

describe("preferences and arguments", () => {
  test("settings never persist credentials and validate endpoint shape", async () => {
    const directory = await mkdtemp(join(tmpdir(), "baas-settings-"));
    try {
      expect(await loadSettings(directory)).toEqual({ url: "ws://127.0.0.1:8190" });
      const path = await saveSettings(
        { url: "ws://localhost:8190", key: "secret", apiKey: "secret" } as any,
        directory
      );
      expect(await readFile(path, "utf8")).not.toContain("secret");
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(normalizeEndpoint("https://example.com/baas/")).toBe("wss://example.com/baas");
      expect(() => normalizeEndpoint("ws://user:secret@host")).toThrow("凭据");
      expect(() => normalizeEndpoint("file:///tmp/baas")).toThrow("服务地址");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("tokenization preserves quoted names and never evaluates shell syntax", () => {
    expect(tokenize("use '夏莱 · 国服'")).toEqual(["use", "夏莱 · 国服"]);
    expect(tokenize("config set /name '\"测试\"'")).toEqual(["config", "set", "/name", '"测试"']);
    expect(tokenize("run $(touch /tmp/nope)")).toEqual(["run", "$(touch", "/tmp/nope)"]);
    expect(() => tokenize("use 'broken")).toThrow("引号");
    expect(() => parseArguments(["--server", "ws://host", "--pipe", "/tmp/baas"])).toThrow("只能");
    expect(() => parseArguments(["--timeout", "NaN"])).toThrow("timeout");
  });
});

describe("CLI subprocess contract", () => {
  const entry = join(import.meta.dir, "../src/index.ts");
  async function run(args: string[]) {
    const process = Bun.spawn(
      [Bun.which("bun")!, entry, "--config-home", "/tmp/baas-cli-test-no-settings", ...args],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { ...globalThis.process.env, BAAS_KEY: undefined, BAAS_PROFILE: undefined },
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { stdout, stderr, code };
  }
  test("help and version consistently identify the baasx program", async () => {
    const version = await run(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^baasx \d/);
    const json = await run(["--json", "--version"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ name: "baasx" });
    const usage = await run(["--lang", "en", "--help"]);
    expect(usage.code).toBe(0);
    expect(usage.stdout).toContain("Usage: baasx [options] [command]");
    expect(usage.stdout).not.toContain("BAAS CLI");
    expect(usage.stdout).not.toContain("Usage: baas ");
  });
  test("JSON contains exactly one document without banners or ANSI", async () => {
    const result = await run(["--demo", "--json", "profiles"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty("sensei-cn");
    expect(result.stdout).not.toContain("\x1b");
    expect(result.stderr).toBe("");
  });
  test("noninteractive writes need explicit approval", async () => {
    const denied = await run(["--demo", "--json", "start"]);
    expect(denied.code).toBe(1);
    expect(JSON.parse(denied.stdout).error).toContain("--yes");
    const allowed = await run(["--demo", "--json", "--yes", "run", "collect_reward"]);
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout)).toMatchObject({ accepted: true, completed: false });
  });
  test("command packs obey read-only and emit clean JSON", async () => {
    const result = await run(["--demo", "--json", "pack", "briefing"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).results).toHaveLength(2);
    const denied = await run(["--demo", "--json", "--read-only", "pack", "daily"]);
    expect(denied.code).toBe(1);
    expect(JSON.parse(denied.stdout).error).toContain("只读");
  });
});
