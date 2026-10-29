import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BaasClient,
  type BaasLogEntry,
  type BaasStatusSnapshot,
  type BaasStatusUpdate,
} from "@baas/client";
import { DemoClient } from "../src/demo";
import { Workspace, type WorkspaceSnapshot } from "../src/workspace";
import { RuntimeManager } from "../src/runtime";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "baas-workspace-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function demo(options: Parameters<typeof Workspace.create>[0] = {}) {
  const workspace = await Workspace.create({
    demo: true,
    directory: await directory(),
    ...options,
  });
  cleanup.push(() => workspace.close());
  return workspace;
}
async function until(
  workspace: Workspace,
  matches: (snapshot: WorkspaceSnapshot) => boolean
): Promise<WorkspaceSnapshot> {
  if (matches(workspace.snapshot)) return workspace.snapshot;
  return new Promise((resolve, reject) => {
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      reject(new Error("Workspace state did not arrive"));
    }, 2000);
    off = workspace.subscribe((snapshot) => {
      if (matches(snapshot)) {
        clearTimeout(timer);
        off();
        resolve(snapshot);
      }
    });
  });
}
function internalClient(workspace: Workspace) {
  return (workspace as unknown as { client: DemoClient }).client;
}

test("local installation respects read-only and dry-run without starting the helper", async () => {
  const install = spyOn(RuntimeManager.prototype, "install");
  const start = spyOn(RuntimeManager.prototype, "start");
  cleanup.push(() => {
    install.mockRestore();
    start.mockRestore();
  });
  const readOnly = await Workspace.create({ directory: await directory(), readOnly: true });
  cleanup.push(() => readOnly.close());
  await readOnly.installLocal();
  expect(readOnly.snapshot.prompt).toBeUndefined();
  expect(readOnly.snapshot.activity.at(-1)?.detail).toContain("只读");
  const preview = await Workspace.create({ directory: await directory(), dryRun: true });
  cleanup.push(() => preview.close());
  const pending = preview.installLocal();
  await until(preview, (state) => state.prompt?.kind === "text");
  preview.answerPrompt("/preview-only-runtime");
  await pending;
  expect(preview.snapshot.activity.at(-1)?.title).toContain("预演");
  expect(preview.snapshot.setupNeeded).toBe(true);
  expect(install).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

function serviceFixture() {
  const state = {
    connects: 0,
    key: "",
    disconnect: (_error: Error) => {},
    log: (_entry: BaasLogEntry) => {},
    status: (_update: BaasStatusUpdate, _snapshot: BaasStatusSnapshot) => {},
  };
  const spies = [
    spyOn(BaasClient.prototype, "connect").mockImplementation(async function (this: BaasClient) {
      state.connects++;
      state.key = (this as unknown as { options: { key: string } }).options.key;
    }),
    spyOn(BaasClient.prototype, "profiles").mockResolvedValue({ alpha: "Fixture" }),
    spyOn(BaasClient.prototype, "status").mockResolvedValue({ alpha: { running: false } }),
    spyOn(BaasClient.prototype, "tasks").mockResolvedValue({
      arena: { event_name: "Arena", enabled: true },
    }),
    spyOn(BaasClient.prototype, "logs").mockResolvedValue([]),
    spyOn(BaasClient.prototype, "onLog").mockImplementation((listener) => {
      state.log = listener;
      return () => {};
    }),
    spyOn(BaasClient.prototype, "onStatus").mockImplementation((listener) => {
      state.status = listener;
      return () => {};
    }),
    spyOn(BaasClient.prototype, "onDisconnect").mockImplementation((listener) => {
      state.disconnect = listener;
      return () => {};
    }),
  ];
  cleanup.push(() => {
    for (const spy of spies) spy.mockRestore();
  });
  return state;
}

test("explicit endpoints override saved local mode and language switching keeps the connection", async () => {
  const folder = await directory();
  await writeFile(
    join(folder, "settings.json"),
    JSON.stringify({ connectionMode: "local", language: "en" })
  );
  const service = serviceFixture();
  const start = spyOn(RuntimeManager.prototype, "start");
  cleanup.push(() => start.mockRestore());
  const workspace = await Workspace.create({
    directory: folder,
    server: "ws://127.0.0.1:19876",
    key: "fixture",
  });
  cleanup.push(() => workspace.close());
  await workspace.initialize();
  expect(workspace.snapshot.connected).toBe(true);
  expect(workspace.snapshot.endpoint).toBe("ws://127.0.0.1:19876");
  const connects = service.connects;
  await workspace.setLanguage("ja");
  expect(workspace.snapshot.language).toBe("ja");
  expect(service.connects).toBe(connects);
  expect(start).not.toHaveBeenCalled();
});

test("saved endpoints from older settings reconnect without repeating first-run setup", async () => {
  const folder = await directory();
  await writeFile(
    join(folder, "settings.json"),
    JSON.stringify({ url: "ws://127.0.0.1:19876", language: "en" })
  );
  serviceFixture();
  const workspace = await Workspace.create({ directory: folder, key: "fixture" });
  cleanup.push(() => workspace.close());
  expect(workspace.snapshot.setupNeeded).toBe(false);
  await workspace.initialize();
  expect(workspace.snapshot.connected).toBe(true);
  expect(workspace.snapshot.endpoint).toBe("ws://127.0.0.1:19876");
});

describe("creating the first BAAS profile", () => {
  test("an empty installation can create, select and use its first real configuration", async () => {
    const workspace = await demo();
    await workspace.connect();
    const empty = internalClient(workspace) as unknown as {
      configs: Record<string, unknown>;
      state: BaasStatusSnapshot;
    };
    empty.configs = {};
    empty.state = {};
    await workspace.refresh();
    expect(workspace.snapshot.profiles).toEqual({});
    expect(workspace.snapshot.profile).toBeUndefined();
    const creating = workspace.addProfile();
    await until(workspace, (state) => state.prompt?.title === "配置档名称");
    workspace.answerPrompt("老师的首个配置档");
    const server = await until(workspace, (state) => state.prompt?.title === "选择服务器");
    expect(server.prompt?.detail).toContain("官服、B服、国际服、国际服青少年、韩国ONE、日服");
    workspace.answerPrompt("官服");
    await until(workspace, (state) => state.prompt?.title === "确认新建配置档");
    workspace.answerPrompt(true);
    await creating;
    const profile = workspace.snapshot.profile!;
    expect(profile).toStartWith("demo-");
    expect(workspace.snapshot.profiles).toEqual({ [profile]: "老师的首个配置档" });
    expect(await internalClient(workspace).config(profile)).toMatchObject({
      name: "老师的首个配置档",
      server: "官服",
    });
    expect(workspace.snapshot.tasks.collect_reward).toBeDefined();
    const running = workspace.run("collect_reward");
    await until(workspace, (state) => state.prompt?.kind === "confirm");
    workspace.answerPrompt(true);
    await running;
    expect(workspace.snapshot.status[profile].running).toBe(true);
  });

  test("creation denial, read-only and dry-run leave profiles unchanged", async () => {
    const workspace = await demo();
    await workspace.connect();
    const before = workspace.snapshot.profiles;
    const creating = workspace.createProfile("Should not exist", "日服");
    await until(workspace, (state) => state.prompt?.kind === "confirm");
    workspace.answerPrompt(false);
    await creating;
    expect(await internalClient(workspace).profiles()).toEqual(before);
    const readOnly = await demo({ readOnly: true, yes: true });
    await readOnly.connect();
    await readOnly.addProfile();
    expect(readOnly.snapshot.prompt).toBeUndefined();
    expect(readOnly.snapshot.activity.at(-1)?.detail).toContain("只读");
    expect(await internalClient(readOnly).profiles()).toEqual(before);
    const preview = await demo({ dryRun: true });
    await preview.connect();
    await preview.createProfile("Preview profile", "国际服");
    expect(preview.snapshot.prompt).toBeUndefined();
    expect(preview.snapshot.activity.at(-1)?.title).toContain("预演");
    expect(await internalClient(preview).profiles()).toEqual(before);
  });

  test("quoted profile commands use desktop server wire values and preserve existing demo IDs", async () => {
    const workspace = await demo({ yes: true });
    await workspace.connect();
    await workspace.execute('/profile create "My Summer profile" "日服"');
    const created = workspace.snapshot.profile!;
    expect(workspace.snapshot.profiles["sensei-cn"]).toBe("夏莱 · 国服");
    expect(workspace.snapshot.profiles["sensei-jp"]).toBe("夏莱 · 日服");
    expect(workspace.snapshot.profiles[created]).toBe("My Summer profile");
    expect((await internalClient(workspace).config(created)).server).toBe("日服");
  });

  test("invalid servers, duplicate names and name races never submit another profile", async () => {
    const workspace = await demo();
    await workspace.connect();
    await workspace.createProfile("Invalid server", "CN");
    expect(workspace.snapshot.activity.at(-1)?.detail).toContain("服务器无效");
    expect(workspace.snapshot.prompt).toBeUndefined();
    await workspace.createProfile("夏莱 · 国服", "官服");
    expect(workspace.snapshot.activity.at(-1)?.detail).toContain("同名");
    const creating = workspace.createProfile("Racing name", "日服");
    await until(workspace, (state) => state.prompt?.kind === "confirm");
    await internalClient(workspace).request("add_config", undefined, {
      name: "Racing name",
      server: "日服",
    });
    workspace.answerPrompt(true);
    await creating;
    expect(
      Object.values(await internalClient(workspace).profiles()).filter(
        (name) => name === "Racing name"
      )
    ).toHaveLength(1);
    expect(workspace.snapshot.activity.at(-1)?.detail).toContain("确认期间");
    expect(workspace.snapshot.profile).toBe("sensei-cn");
  });
});

describe("deterministic BAAS workspace", () => {
  test("loads standalone packs and displays live demo profiles, tasks and status", async () => {
    const workspace = await demo();
    expect(workspace.snapshot.connected).toBe(false);
    expect(workspace.snapshot.packs.map((pack) => pack.name)).toContain("briefing");
    await workspace.connect();
    expect(workspace.snapshot).toMatchObject({
      connected: true,
      connecting: false,
      profile: "sensei-cn",
      demo: true,
    });
    expect(workspace.snapshot.profiles["sensei-cn"]).toBe("夏莱 · 国服");
    expect(workspace.snapshot.tasks.collect_reward.event_name).toBe("收取奖励");
    expect(workspace.snapshot.status["sensei-cn"].running).toBe(false);
    expect(JSON.stringify(workspace.snapshot)).not.toMatch(/aiBaseUrl|agentConfig|languageModel/);
  });

  test("snapshots and subscriber copies cannot mutate controller state", async () => {
    const workspace = await demo();
    workspace.subscribe((snapshot) => {
      snapshot.profile = "corrupted";
      snapshot.activity.length = 0;
    });
    let observed = "";
    const off = workspace.subscribe((snapshot) => {
      observed = snapshot.profile || "";
    });
    await workspace.connect();
    expect(observed).toBe("sensei-cn");
    const snapshot = workspace.snapshot;
    snapshot.tasks.collect_reward.enabled = false;
    expect(workspace.snapshot.tasks.collect_reward.enabled).toBe(true);
    expect(workspace.snapshot.activity.length).toBeGreaterThan(0);
    off();
  });

  test("mutation confirmation can be declined, then accepted without claiming completion", async () => {
    const workspace = await demo();
    await workspace.connect();
    const denied = workspace.run("collect_reward");
    await until(workspace, (state) => state.prompt?.kind === "confirm");
    workspace.answerPrompt(false);
    await denied;
    expect(workspace.snapshot.status["sensei-cn"].running).toBe(false);
    const accepted = workspace.run("collect_reward");
    await until(workspace, (state) => state.prompt?.kind === "confirm");
    workspace.answerPrompt(true);
    await accepted;
    expect(workspace.snapshot.status["sensei-cn"].running).toBe(true);
    expect(workspace.snapshot.activity.some((item) => item.title.includes("已提交"))).toBe(true);
    await until(workspace, (state) => state.status["sensei-cn"].running === false);
    expect(workspace.snapshot.logs.some((entry) => entry.message.includes("执行完成"))).toBe(true);
  });

  test("concurrent submissions cannot overwrite a pending approval or run twice", async () => {
    const workspace = await demo();
    await workspace.connect();
    const running = workspace.run("collect_reward");
    await until(workspace, (state) => state.prompt?.kind === "confirm");
    const prompt = workspace.snapshot.prompt;
    await workspace.start();
    await workspace.selectProfile("sensei-jp");
    expect(workspace.snapshot.prompt).toEqual(prompt);
    expect(workspace.snapshot.profile).toBe("sensei-cn");
    workspace.answerPrompt(true);
    await running;
    expect(
      workspace.snapshot.logs.filter((entry) => entry.message.includes("演示开始"))
    ).toHaveLength(1);
  });

  test("read-only and dry-run use the common action permission boundary", async () => {
    const readOnly = await demo({ readOnly: true, yes: true });
    await readOnly.connect();
    await readOnly.run("collect_reward");
    expect(readOnly.snapshot.status["sensei-cn"].running).toBe(false);
    expect(readOnly.snapshot.activity.at(-1)?.detail).toContain("只读");
    expect(readOnly.snapshot.prompt).toBeUndefined();
    const dryRun = await demo({ dryRun: true });
    await dryRun.connect();
    await dryRun.setConfig("/name", "Preview only");
    expect((await dryRun.getConfig()).name).toBe("夏莱 · 国服");
    expect(dryRun.snapshot.activity.some((item) => item.title.includes("预演"))).toBe(true);
    expect(dryRun.snapshot.prompt).toBeUndefined();
  });

  test("configuration changed during approval is never silently overwritten", async () => {
    const workspace = await demo();
    await workspace.connect();
    const setting = workspace.setConfig("/name", "Requested name");
    await until(workspace, (state) => state.prompt?.kind === "confirm");
    await internalClient(workspace).patchConfig("sensei-cn", "/name", "External change");
    workspace.answerPrompt(true);
    await setting;
    expect((await workspace.getConfig()).name).toBe("External change");
    expect(
      workspace.snapshot.activity.some(
        (item) => item.tone === "error" && item.detail?.includes("确认期间")
      )
    ).toBe(true);
  });

  test("selecting another profile refreshes its tasks and routes later mutations there", async () => {
    const workspace = await demo({ yes: true });
    await workspace.connect();
    await workspace.selectProfile("夏莱 · 日服");
    expect(workspace.snapshot.profile).toBe("sensei-jp");
    expect(workspace.snapshot.tasks.cafe).toBeDefined();
    await workspace.start();
    expect(workspace.snapshot.status["sensei-jp"].running).toBe(true);
    expect(workspace.snapshot.status["sensei-cn"].running).toBe(false);
    await workspace.stop();
    expect(workspace.snapshot.status["sensei-jp"].running).toBe(false);
  });

  test("cancel stops a local wait without stopping the submitted backend task", async () => {
    const workspace = await demo({ yes: true });
    await workspace.connect();
    const pending = workspace.execute("/daily-wait");
    await until(workspace, (state) => state.status["sensei-cn"].running === true);
    workspace.cancel();
    await pending;
    expect(workspace.snapshot.busy).toBeUndefined();
    expect(workspace.snapshot.status["sensei-cn"].running).toBe(true);
    expect(workspace.snapshot.connected).toBe(true);
    await workspace.stop();
    expect(workspace.snapshot.status["sensei-cn"].running).toBe(false);
  });

  test("missing login key uses a cancellable secret prompt before opening a socket", async () => {
    const workspace = await Workspace.create({
      server: "ws://127.0.0.1:1",
      key: "",
      directory: await directory(),
    });
    cleanup.push(() => workspace.close());
    const pending = workspace.connect();
    await until(workspace, (state) => state.prompt?.kind === "secret");
    workspace.answerPrompt(null);
    await pending;
    expect(workspace.snapshot).toMatchObject({ connected: false, connecting: false });
    expect(workspace.snapshot.prompt).toBeUndefined();
    expect(workspace.snapshot.busy).toBeUndefined();
  });

  test("entered login key remains ephemeral while selected profile preferences persist", async () => {
    const fixture = serviceFixture(),
      path = await directory();
    const workspace = await Workspace.create({
      server: "ws://127.0.0.1:8190",
      key: "",
      directory: path,
    });
    cleanup.push(() => workspace.close());
    const pending = workspace.connect();
    await until(workspace, (state) => state.prompt?.kind === "secret");
    workspace.answerPrompt("fixture-login-secret");
    await pending;
    await workspace.selectProfile("alpha");
    expect(fixture.key).toBe("fixture-login-secret");
    expect(JSON.stringify(workspace.snapshot)).not.toContain("fixture-login-secret");
    const saved = await readFile(join(path, "settings.json"), "utf8");
    expect(saved).toContain("alpha");
    expect(saved).not.toContain("fixture-login-secret");
  });

  test("streaming updates stay bounded and late callbacks from logout are ignored", async () => {
    const fixture = serviceFixture();
    const workspace = await Workspace.create({
      key: "fixture-key",
      profile: "alpha",
      directory: await directory(),
    });
    cleanup.push(() => workspace.close());
    await workspace.connect();
    for (let index = 0; index < 350; index++)
      fixture.log({
        scope: "config:alpha",
        time: String(index),
        level: "INFO",
        message: `log-${index}`,
      });
    expect(workspace.snapshot.logs).toHaveLength(300);
    for (let index = 0; index < 80; index++) await workspace.execute("help");
    expect(workspace.snapshot.activity).toHaveLength(60);
    fixture.disconnect(new Error("Fixture disconnected"));
    expect(workspace.snapshot.connected).toBe(false);
    await workspace.refresh();
    expect(fixture.connects).toBe(2);
    await workspace.execute("logout");
    fixture.status({ full: true, configId: null, status: {} }, { alpha: { running: true } });
    fixture.log({ scope: "config:alpha", time: "late", level: "INFO", message: "late" });
    expect(workspace.snapshot.status).toEqual({});
    expect(workspace.snapshot.logs).toEqual([]);
  });

  test("pack preflight catches an invalid later task before starting any step", async () => {
    const path = await directory();
    await mkdir(join(path, "commands"));
    await writeFile(
      join(path, "commands", "bad.json"),
      JSON.stringify({
        id: "bad-plan",
        name: "Bad plan",
        description: "Must not run",
        version: 1,
        commands: [
          {
            name: "bad-plan",
            description: "Bad plan",
            steps: [
              { action: "scheduler_start", args: {} },
              { action: "task_run", args: { task: "not-a-real-task" } },
            ],
          },
        ],
      })
    );
    const workspace = await demo({ directory: path, yes: true });
    await workspace.connect();
    await workspace.execute("/pack bad-plan");
    expect(workspace.snapshot.status["sensei-cn"].running).toBe(false);
    expect(workspace.snapshot.logs.some((entry) => entry.message.includes("演示开始"))).toBe(false);
    expect(workspace.snapshot.activity.at(-1)?.detail).toContain("未执行任何步骤");
  });

  test("only explicit commands execute; invalid arguments and prose become activity errors", async () => {
    const workspace = await demo();
    await workspace.connect();
    await workspace.execute("/briefing");
    expect(workspace.snapshot.activity.some((item) => item.title === "briefing → tasks")).toBe(
      true
    );
    await workspace.execute("请帮我领取奖励");
    expect(workspace.snapshot.activity.at(-1)?.detail).toContain("未知指令");
    await workspace.execute("start extra");
    expect(workspace.snapshot.activity.at(-1)?.tone).toBe("error");
    await workspace.execute("config set /name not-json");
    expect(workspace.snapshot.activity.at(-1)?.detail).toContain("JSON");
    expect(workspace.snapshot.status["sensei-cn"].running).toBe(false);
  });

  test("known keys are redacted from approval, activity and configuration display", async () => {
    const secret = "fixture-known-secret";
    const workspace = await demo({ key: secret });
    await workspace.connect();
    const pending = workspace.setConfig("/name", secret);
    await until(workspace, (state) => state.prompt?.kind === "confirm");
    expect(JSON.stringify(workspace.snapshot)).not.toContain(secret);
    workspace.answerPrompt(true);
    await pending;
    expect((await workspace.getConfig()).name).toBe("[REDACTED]");
    expect(JSON.stringify(workspace.snapshot)).not.toContain(secret);
  });
  test("each confirmation has a fresh prompt ID and hidden placeholders never become real values", async () => {
    const workspace = await demo();
    await workspace.connect();
    const first = workspace.setConfig("/name", "First value");
    const firstPrompt = await until(workspace, (state) => state.prompt?.kind === "confirm");
    workspace.answerPrompt(false);
    await first;
    const second = workspace.setConfig("/name", "Second value");
    const secondPrompt = await until(workspace, (state) => state.prompt?.kind === "confirm");
    expect(secondPrompt.prompt?.id).not.toBe(firstPrompt.prompt?.id);
    workspace.answerPrompt(false);
    await second;
    await workspace.setConfig("/name", { nested: ["[REDACTED]"] });
    expect(workspace.snapshot.prompt).toBeUndefined();
    expect((await workspace.getConfig()).name).toBe("夏莱 · 国服");
    await workspace.execute("config set /name '\"[REDACTED]\"'");
    expect(workspace.snapshot.prompt).toBeUndefined();
    expect(workspace.snapshot.activity.at(-1)?.detail).toContain("占位符");
    const clear = workspace.setConfig("/name", "");
    await until(workspace, (state) => state.prompt?.kind === "confirm");
    workspace.answerPrompt(true);
    await clear;
    expect((await workspace.getConfig()).name).toBe("");
  });

  test("task activities describe actual submission and completion without JSON envelopes", async () => {
    const workspace = await demo({ yes: true });
    await workspace.connect();
    await workspace.run("mail");
    const submission = workspace.snapshot.activity.find(
      (item) => item.title.includes("邮件") && item.title.includes("已提交")
    );
    expect(submission?.detail).toContain("后台");
    expect(submission?.detail).not.toContain('"accepted"');
    await until(workspace, (state) => state.status["sensei-cn"].running === false);
    expect(
      workspace.snapshot.activity.some(
        (item) => item.title.includes("邮件") && item.title.includes("已完成")
      )
    ).toBe(true);
  });
});
