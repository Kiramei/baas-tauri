import React from "react";
import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { configChoices, filterChoices, WorkspaceView } from "../src/workspace-view";
import type { Workspace, WorkspaceSnapshot } from "../src/workspace";
import { displayWidth, terminalText } from "../src/ui";
import { MouseContext } from "../src/terminal-components";
import { MouseBus, type MouseEvent } from "../src/terminal";
import { reduceInstallationProgress } from "../src/installation";
import manifest from "../package.json";

function fixture(overrides: Partial<WorkspaceSnapshot> = {}) {
  let state: WorkspaceSnapshot = {
    version: "0.1.0",
    endpoint: "演示环境 · 本地沙盒",
    demo: true,
    connected: true,
    connecting: false,
    profile: "sensei-cn",
    profiles: { "sensei-cn": "老师的配置" },
    tasks: {},
    status: {},
    logs: [],
    activity: [],
    readOnly: false,
    dryRun: false,
    packs: [],
    ...overrides,
  };
  const listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  const answers: Array<string | boolean | null> = [];
  const commands: string[] = [];
  const writes: Array<{ path: string; value: unknown }> = [];
  const configReads: Array<string | undefined> = [];
  let cancelled = 0;
  let reloads = 0;
  let clears = 0;
  let configuration: Record<string, unknown> = {};
  const publish = (next: Partial<WorkspaceSnapshot>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener(structuredClone(state));
  };
  const workspace = {
    get snapshot() {
      return structuredClone(state);
    },
    subscribe(listener: (snapshot: WorkspaceSnapshot) => void) {
      listeners.add(listener);
      listener(structuredClone(state));
      return () => listeners.delete(listener);
    },
    answerPrompt(value: string | boolean | null) {
      answers.push(value);
      publish({ prompt: undefined });
    },
    cancel() {
      cancelled++;
      publish({ prompt: undefined, busy: undefined });
    },
    close() {},
    clearScreen() {
      clears++;
      publish({ activity: [], logs: [] });
    },
    async connect() {},
    async selectProfile(profile: string) {
      publish({ profile });
    },
    async run() {},
    async execute(command: string) {
      commands.push(command);
      if (command === "reload") await workspace.reload();
    },
    async reload() {
      reloads++;
      publish({ reloadRevision: (state.reloadRevision ?? 0) + 1 });
    },
    async getConfig() {
      configReads.push(state.profile);
      return configuration;
    },
    async setConfig(path: string, value: unknown) {
      writes.push({ path, value });
    },
  } as unknown as Workspace;
  return {
    workspace,
    answers,
    commands,
    writes,
    configReads,
    publish,
    setConfig: (value: Record<string, unknown>) => (configuration = value),
    get cancelled() {
      return cancelled;
    },
    get reloads() {
      return reloads;
    },
    get clears() {
      return clears;
    },
    get subscribers() {
      return listeners.size;
    },
  };
}

async function mounted(
  target: ReturnType<typeof fixture>,
  options: { columns?: number; rows?: number } = {}
) {
  const frames: string[] = [];
  let rawModeActivations = 0;
  const mouse = new MouseBus();
  mouse.setMaxListeners(200);
  const rawFrames: string[] = [];
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        const frame = terminalText(String(chunk));
        if (frame.includes("BAASX")) {
          frames.push(frame);
          rawFrames.push(String(chunk));
        }
        callback();
      },
    }),
    { columns: options.columns ?? 80, rows: options.rows ?? 30, isTTY: true }
  );
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(enabled: boolean) {
      if (enabled) rawModeActivations++;
    },
    ref() {},
    unref() {},
  });
  const app = render(
    <MouseContext.Provider value={mouse}>
      <WorkspaceView workspace={target.workspace} />
    </MouseContext.Provider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
      maxFps: 1000,
    }
  );
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 35));
  await settle();
  return {
    mouse,
    async mouseEvent(event: MouseEvent) {
      mouse.dispatch(event);
      await settle();
    },
    async resize(columns: number) {
      stdout.columns = columns;
      stdout.emit("resize");
      await settle();
    },
    get frame() {
      return frames.at(-1) || "";
    },
    get frames() {
      return [...frames];
    },
    get rawFrame() {
      return rawFrames.at(-1) || "";
    },
    get rawModeActivations() {
      return rawModeActivations;
    },
    async waitForInputRemount(previous: number) {
      const deadline = Date.now() + 2_000;
      while (rawModeActivations <= previous) {
        if (Date.now() >= deadline) throw new Error("Terminal input did not remount after reload");
        await Bun.sleep(10);
      }
    },
    async waitForFrame(text: string) {
      const deadline = Date.now() + 2_000;
      while (!(frames.at(-1) || "").includes(text)) {
        if (Date.now() >= deadline) {
          throw new Error(
            `Terminal did not render ${JSON.stringify(text)}:\n${frames.at(-1) || ""}`
          );
        }
        await Bun.sleep(10);
      }
    },
    async send(input: string) {
      stdin.write(input);
      await settle();
    },
    async click(label: string, match: (line: string) => boolean = () => true, last = false) {
      const lines = (frames.at(-1) || "").split("\n");
      const y = lines.findIndex((line) => line.includes(label) && match(line));
      expect(y).toBeGreaterThanOrEqual(0);
      const x = displayWidth(
        lines[y].slice(0, last ? lines[y].lastIndexOf(label) : lines[y].indexOf(label))
      );
      mouse.dispatch({ x, y, button: 0, kind: "press", delta: 0 });
      await settle();
    },
    async update(state: Partial<WorkspaceSnapshot>) {
      target.publish(state);
      await settle();
    },
    close() {
      app.unmount();
      app.cleanup();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

describe("startup navigation", () => {
  test("clear uses its own action, and packs remain a command without a navigation page", async () => {
    const target = fixture();
    const ui = await mounted(target);
    try {
      const nav = ui.frame
        .split("\n")
        .find((line) => line.includes("总览") && line.includes("日志"));
      expect(nav).not.toContain("指令包");
      await ui.send("/clear");
      await ui.send("\r");
      expect(target.clears).toBe(1);
      await ui.send("/packs");
      await ui.send("\r");
      expect(target.commands).toContain("packs");
    } finally {
      ui.close();
    }
  });

  test("clear keeps the current page and connection while clearing displayed output", async () => {
    const target = fixture({
      tasks: { mail: { event_name: "邮件" } },
      activity: [{ id: "old", title: "先前活动", tone: "info" }],
    });
    const ui = await mounted(target);
    try {
      await ui.send("/tasks");
      await ui.send("\r");
      expect(ui.frame).toContain("任务列表 · Enter 运行");
      expect(ui.frame).toContain("邮件");
      await ui.send("/clear");
      await ui.send("\r");
      expect(target.clears).toBe(1);
      expect(ui.frame).toContain("任务列表 · Enter 运行");
      expect(ui.frame).toContain("邮件");
      expect(target.workspace.snapshot).toMatchObject({
        connected: true,
        profile: "sensei-cn",
        tasks: { mail: { event_name: "邮件" } },
        activity: [],
      });
    } finally {
      ui.close();
    }
  });
  const running = () =>
    reduceInstallationProgress(undefined, {
      type: "progress",
      stage: "backend",
      taskId: "launch-backend",
      status: "running",
      message: "Waiting for backend handshake",
    });
  const ready = (progress: ReturnType<typeof running>) =>
    reduceInstallationProgress(progress, {
      type: "progress",
      stage: "ready",
      taskId: "launch-backend",
      status: "complete",
      message: "Backend ready",
    });

  test.each([false, true])(
    "connected startup returns home with retained progress=%s",
    async (retain) => {
      const progress = running();
      const target = fixture({ connected: false, busy: "启动本地后端", installation: progress });
      const ui = await mounted(target);
      try {
        expect(ui.frame).toContain("[1/1] 启动本地后端");
        await ui.update({
          connected: true,
          busy: undefined,
          installation: retain ? ready(progress) : undefined,
          activity: [{ id: "connected", title: "连接已建立", tone: "success" }],
        });
        await ui.waitForFrame("项任务 ·");
        expect(ui.frame).toContain("项任务 ·");
        expect(ui.frame).not.toContain("[1/1]");

        // An unrelated operation must not resurrect old startup progress.
        await ui.update({ busy: "新建配置档", installation: ready(progress) });
        expect(ui.frame).toContain("项任务 ·");
        expect(ui.frame).not.toContain("[1/1]");
        await ui.update({ busy: undefined });
        await ui.click("任务", (line) => line.includes("总览"));
        await ui.update({
          logs: [{ time: "now", level: "INFO", scope: "backend", message: "late backend log" }],
        });
        expect(ui.frame).not.toContain("项任务 ·");
        expect(ui.frame).not.toContain("[1/1]");
      } finally {
        ui.close();
      }
    }
  );

  test("a failed startup keeps diagnostics until a successful retry returns home", async () => {
    const progress = running();
    const target = fixture({ connected: false, busy: "启动本地后端", installation: progress });
    const ui = await mounted(target);
    try {
      await ui.update({
        busy: undefined,
        installation: reduceInstallationProgress(progress, {
          type: "progress",
          stage: "error",
          status: "failed",
          message: "Backend handshake failed",
        }),
        activity: [{ id: "failed", title: "启动本地后端失败", tone: "error" }],
      });
      await ui.waitForFrame("Backend handshake failed");
      expect(ui.frame).toContain("Backend handshake failed");
      expect(ui.frame).not.toContain("项任务 ·");
      const retry = running();
      await ui.update({ busy: "启动本地后端", installation: retry });
      await ui.update({
        connected: true,
        busy: undefined,
        installation: ready(retry),
        activity: [{ id: "connected", title: "连接已建立", tone: "success" }],
      });
      await ui.waitForFrame("项任务 ·");
      expect(ui.frame).toContain("项任务 ·");
      expect(ui.frame).not.toContain("[1/1]");
    } finally {
      ui.close();
    }
  });
});

describe("workspace choices", () => {
  test("matches task IDs, CJK labels and descriptions without changing source choices", () => {
    const items = [
      { id: "mail", label: "领取邮件", detail: "Daily rewards" },
      { id: "cafe", label: "咖啡厅", detail: "体力" },
    ];
    expect(filterChoices(items, " MAIL ")).toEqual([items[0]]);
    expect(filterChoices(items, "邮件")).toEqual([items[0]]);
    expect(filterChoices(items, "rewards")).toEqual([items[0]]);
    expect(filterChoices(items, "不存在")).toEqual([]);
    expect(items).toHaveLength(2);
  });

  test("configuration choices expose desktop controls, not arbitrary backend JSON", () => {
    const choices = configChoices({
      server: "官服",
      screenshot_method: "adb",
      internal_token: "private",
      nested: { secret: true },
    });
    expect(choices.some((choice) => choice.id === "/screenshot_method")).toBe(true);
    expect(
      choices.some((choice) => choice.id.includes("internal") || choice.id.includes("secret"))
    ).toBe(false);
  });
});

describe("workspace input", () => {
  test("one-off tasks have a separate task tab and dispatch the desktop activity aliases", async () => {
    const target = fixture({ tasks: { mail: { event_name: "邮件" } } });
    const runs: string[] = [];
    target.workspace.run = async (task) => {
      runs.push(task);
      target.publish({ prompt: { kind: "confirm", title: "确认提交 BAAS 操作", detail: task } });
    };
    const ui = await mounted(target);
    try {
      await ui.send("/tasks");
      await ui.send("\r");
      expect(ui.frame).toContain("日常任务");
      expect(ui.frame).toContain("一次性任务");
      expect(ui.frame).toContain("邮件");
      expect(ui.frame).not.toContain("活动挑战");
      await ui.click("一次性任务");
      expect(ui.frame).toContain("一次性任务 · Enter 运行");
      expect(ui.frame).toContain("活动剧情");
      expect(ui.frame).toContain("活动任务");
      expect(ui.frame).toContain("活动挑战");
      expect(ui.frame).toContain("主线剧情");
      expect(ui.frame).not.toContain("邮件");
      for (const [label, id] of [
        ["活动剧情", "start_explore_activity_story"],
        ["活动任务", "start_explore_activity_mission"],
        ["活动挑战", "start_explore_activity_challenge"],
      ]) {
        await ui.click(label);
        expect(ui.frame).toContain("确认提交 BAAS 操作");
        expect(ui.frame).toContain(id);
        await ui.send("n");
        await ui.send("\r");
        await ui.send("/oneoff");
        await ui.send("\r");
      }
      expect(runs).toEqual([
        "start_explore_activity_story",
        "start_explore_activity_mission",
        "start_explore_activity_challenge",
      ]);
      expect(target.answers).toEqual([false, false, false]);
      await ui.send("\x1b");
      expect(ui.frame).toContain("任务列表 · Enter 运行");
      expect(ui.frame).toContain("邮件");
      await ui.send("/run start_explore_activity_story");
      await ui.send("\r");
      expect(target.commands).toContain("run start_explore_activity_story");
    } finally {
      ui.close();
    }
  });

  test("one-off entry selects a profile first and resumes the one-off list", async () => {
    const target = fixture({ profile: undefined });
    const ui = await mounted(target);
    try {
      await ui.send("/oneoff");
      await ui.send("\r");
      expect(ui.frame).toContain("配置档 · Enter 切换");
      await ui.send("\r");
      expect(ui.frame).toContain("一次性任务 · Enter 运行");
      expect(ui.frame).toContain("活动挑战");
    } finally {
      ui.close();
    }
  });

  test.each([
    [30, 1],
    [20, 0],
    [12, 0],
  ])(
    "home has adaptive top spacing at %s rows while configuration keeps a one-row gap",
    async (rows, spacing) => {
      const target = fixture();
      target.setConfig({ screenshot_method: "adb" });
      const ui = await mounted(target, { rows });
      try {
        const lines = ui.frame.split("\n");
        const tabs = lines.findIndex((line) => line.includes("总览") && line.includes("配置"));
        const content = lines.findIndex(
          (line) => line.includes("老师的配置") && line.includes("○ 空闲")
        );
        expect(content - tabs - 1).toBe(spacing);
        expect(lines.slice(tabs + 1, content).every((line) => !line.trim())).toBe(true);
        expect(ui.frame).toContain("输入 /");
        await ui.send("/config");
        await ui.send("\r");
        const configLines = ui.frame.split("\n");
        const configTabs = configLines.findIndex(
          (line) => line.includes("总览") && line.includes("配置")
        );
        const category = configLines.findIndex((line) => line.includes("配置分类"));
        expect(category - configTabs).toBe(2);
      } finally {
        ui.close();
      }
    }
  );

  test("/reload remounts the interface and clears navigation, search and command history", async () => {
    const target = fixture();
    target.setConfig({ screenshot_method: "adb" });
    const ui = await mounted(target);
    try {
      await ui.send("/config");
      await ui.send("\r");
      expect(ui.frame).toContain("配置分类");
      await ui.send("/reload");
      expect(ui.frame).toContain("重新加载界面与连接");
      await ui.send("\r");
      expect(target.reloads).toBe(1);
      expect(ui.frame).toContain("项任务 ·");
      expect(ui.frame).not.toContain("配置分类");
      await ui.send("\x1b[A");
      expect(ui.frame).not.toContain("/reload");
      target.setConfig({ screenshot_method: "scrcpy" });
      await ui.send("/config");
      await ui.send("\r");
      await ui.send("screenshot_method");
      expect(ui.frame).toContain("scrcpy");
      expect(ui.frame).not.toContain("ADB");
      expect(target.configReads).toHaveLength(2);
      expect(target.subscribers).toBe(1);
    } finally {
      ui.close();
    }
    expect(target.subscribers).toBe(0);
  });

  test("Ctrl+R discards the current editor draft without writing and can reload repeatedly", async () => {
    const target = fixture();
    target.setConfig({ screenshot_method: "adb" });
    const ui = await mounted(target);
    try {
      await ui.send("/config");
      await ui.send("\r");
      await ui.send("screenshot_method");
      await ui.send("\r");
      expect(ui.frame).toContain("保存");
      await ui.send("\x1b[B");
      await ui.send("\x12");
      expect(target.reloads).toBe(1);
      expect(ui.frame).toContain("项任务 ·");
      expect(target.writes).toEqual([]);
      await ui.send("unsubmitted draft");
      await ui.send("\x12");
      expect(target.reloads).toBe(2);
      expect(ui.frame).not.toContain("unsubmitted draft");
      expect(target.subscribers).toBe(1);
    } finally {
      ui.close();
    }
  });

  test("reload shortcuts do not dismiss a pending confirmation or interrupt a foreground operation", async () => {
    const target = fixture({ busy: "运行任务" });
    const ui = await mounted(target);
    try {
      await ui.send("\x12");
      expect(target.reloads).toBe(0);
      await ui.update({ prompt: { kind: "confirm", title: "确认提交 BAAS 操作" } });
      await ui.send("\x12");
      expect(target.reloads).toBe(0);
      expect(ui.frame).toContain("确认提交 BAAS 操作");
      expect(target.answers).toEqual([]);
    } finally {
      ui.close();
    }
  });

  test("opening configuration without a selected profile offers profiles and resumes the requested tab", async () => {
    const target = fixture({ profile: undefined });
    target.setConfig({ screenshot_method: "adb" });
    const ui = await mounted(target);
    try {
      await ui.click("配置", (line) => line.includes("总览") && line.includes("日志"), true);
      expect(ui.frame).toContain("配置档 · Enter 切换");
      expect(target.configReads).toEqual([]);
      await ui.send("\r");
      expect(target.configReads).toEqual(["sensei-cn"]);
      expect(ui.frame).toContain("配置分类");
      await ui.send("screenshot_method");
      await ui.send("\r");
      expect(ui.frame).toContain("保存");
      expect(ui.frame).toContain("ADB");
    } finally {
      ui.close();
    }
  });

  test("configuration tab and categories can open by mouse and return from a field", async () => {
    const target = fixture();
    target.setConfig({ cafe_reward_use_invitation_ticket: true, screenshot_method: "adb" });
    const ui = await mounted(target);
    try {
      await ui.click("配置", (line) => line.includes("总览") && line.includes("日志"), true);
      expect(ui.frame).toContain("配置分类");
      await ui.click("咖啡厅");
      await ui.waitForFrame("使用邀请券");
      await ui.send("\r");
      await ui.waitForFrame("保存");
      await ui.send("\x1b");
      expect(ui.frame).not.toContain("保存 [");
      expect(ui.frame).toContain("咖啡厅");
    } finally {
      ui.close();
    }
  });

  test("shop configuration selects a shop before showing its goods and returns through each level", async () => {
    const target = fixture({
      staticData: {
        common_shop_price_list: { CN: [["普通商品", 100, "creditpoints"]] },
        tactical_challenge_shop_price_list: { CN: [["竞技商品", 5, "tactical_challenge_coin"]] },
      },
    });
    target.setConfig({
      CommonShopList: [1],
      CommonShopRefreshTime: 0,
      TacticalChallengeShopList: [0],
      TacticalChallengeShopRefreshTime: 1,
    });
    const ui = await mounted(target);
    try {
      await ui.send("/config");
      await ui.send("\r");
      await ui.click("商店购买");
      expect(ui.frame).toContain("选择商店");
      expect(ui.frame).toContain("普通商店");
      expect(ui.frame).toContain("战术对抗赛商店");
      expect(ui.frame).not.toContain("普通商品");
      expect(ui.frame).not.toContain("竞技商品");
      await ui.click("普通商店");
      expect(ui.frame).toContain("商店购买 · 普通商店");
      expect(ui.frame).toContain("普通商品");
      expect(ui.frame).not.toContain("竞技商品");
      await ui.click("普通商品");
      expect(ui.frame).toContain("保存");
      await ui.send("\x1b[D");
      await ui.send("\r");
      expect(target.writes).toEqual([{ path: "/CommonShopList/0", value: 0 }]);
      expect(ui.frame).toContain("商店购买 · 普通商店");
      await ui.send("\x1b");
      expect(ui.frame).toContain("选择商店");
      await ui.click("战术对抗赛商店");
      await ui.waitForFrame("竞技商品");
      expect(ui.frame).not.toContain("普通商品");
      await ui.click("竞技商品");
      await ui.send("\x1b");
      expect(ui.frame).toContain("商店购买 · 战术对抗赛商店");
      await ui.send("\x1b");
      expect(ui.frame).toContain("选择商店");
      await ui.send("\x1b");
      expect(ui.frame).toContain("配置分类");
      expect(ui.frame).not.toContain("选择商店");
    } finally {
      ui.close();
    }
  });

  test("shop goods remain searchable across shops and open in their owning shop", async () => {
    const target = fixture({
      staticData: {
        common_shop_price_list: { CN: [["同名商品", 100, "creditpoints"]] },
        tactical_challenge_shop_price_list: { CN: [["同名商品", 5, "tactical_challenge_coin"]] },
      },
    });
    target.setConfig({ CommonShopList: [1], TacticalChallengeShopList: [0] });
    const ui = await mounted(target);
    try {
      await ui.send("/config");
      await ui.send("\r");
      await ui.send("同名商品");
      expect(ui.frame).toContain("普通商店");
      expect(ui.frame).toContain("战术对抗赛商店");
      await ui.send("\x1b[B");
      await ui.send("\r");
      expect(ui.frame).toContain("保存");
      await ui.send("\x1b");
      expect(ui.frame).toContain("商店购买 · 战术对抗赛商店");
      await ui.send("\x1b");
      await ui.send("CommonShopList");
      await ui.send("\r");
      expect(ui.frame).toContain("保存");
      await ui.send("\x1b");
      expect(ui.frame).toContain("商店购买 · 普通商店");
    } finally {
      ui.close();
    }
  });

  test("profile changes and reload discard the selected shop", async () => {
    const target = fixture();
    target.setConfig({ CommonShopList: [1], TacticalChallengeShopList: [0] });
    const ui = await mounted(target);
    try {
      await ui.send("/config");
      await ui.send("\r");
      await ui.click("商店购买");
      await ui.waitForFrame("选择商店");
      await ui.click("普通商店");
      await ui.waitForFrame("商店购买 · 普通商店");
      await ui.update({ profile: "sensei-jp", profiles: { "sensei-jp": "日服配置" } });
      await ui.waitForFrame("日服配置");
      await ui.send("/config");
      await ui.send("\r");
      await ui.waitForFrame("配置分类");
      await ui.click("商店购买");
      await ui.waitForFrame("选择商店");
      expect(ui.frame).toContain("选择商店");
      await ui.click("战术对抗赛商店");
      // A rendered home frame can precede Ink's passive input effect after
      // the keyed remount. Wait for the new raw-mode listener, not just text.
      const beforeReload = ui.rawModeActivations;
      await ui.send("\x12");
      await ui.waitForInputRemount(beforeReload);
      await ui.waitForFrame("项任务 ·");
      await ui.send("/config");
      await ui.waitForFrame("/config");
      await ui.send("\r");
      await ui.waitForFrame("配置分类");
      await ui.click("商店购买");
      await ui.waitForFrame("选择商店");
      expect(ui.frame).toContain("选择商店");
      expect(target.reloads).toBe(1);
    } finally {
      ui.close();
    }
  });

  test("an older configuration response cannot replace the newly selected profile's fields", async () => {
    const target = fixture();
    let finishOldRead!: (value: Record<string, unknown>) => void;
    let reads = 0;
    target.workspace.getConfig = () =>
      ++reads === 1
        ? new Promise((resolve) => {
            finishOldRead = resolve;
          })
        : Promise.resolve({ screenshot_method: "scrcpy" });
    const ui = await mounted(target);
    try {
      await ui.send("/config");
      await ui.send("\r");
      await ui.update({ profile: "sensei-jp", profiles: { "sensei-jp": "日服配置" } });
      await ui.send("/config");
      await ui.send("\r");
      await ui.send("screenshot_method");
      expect(ui.frame).toContain("scrcpy");
      finishOldRead({ screenshot_method: "adb" });
      await ui.update({});
      expect(ui.frame).toContain("scrcpy");
      expect(ui.frame).not.toContain("ADB");
    } finally {
      ui.close();
    }
  });

  test("Enter uses the requested yes default while no remains selectable", async () => {
    const target = fixture({ prompt: { kind: "confirm", title: "确认提交 BAAS 操作" } });
    const ui = await mounted(target);
    try {
      expect(ui.frame).toContain("取消 [n]");
      await ui.send("\r");
      expect(target.answers).toEqual([true]);
      await ui.update({ prompt: { kind: "confirm", title: "确认提交 BAAS 操作" } });
      await ui.send("n");
      await ui.send("\r");
      expect(target.answers).toEqual([true, false]);
    } finally {
      ui.close();
    }
  });

  test("uninstall confirmation defaults to cancellation", async () => {
    const target = fixture({
      prompt: { kind: "confirm", title: "确认卸载本地环境", initial: "n" },
    });
    const ui = await mounted(target);
    try {
      await ui.send("\r");
      expect(target.answers).toEqual([false]);
    } finally {
      ui.close();
    }
  });

  test("a new confirmation resets a previous no selection back to yes", async () => {
    const title = "确认提交 BAAS 操作";
    const firstPrompt = { id: "first-prompt", kind: "confirm" as const, title };
    const nextPrompt = { id: "next-prompt", kind: "confirm" as const, title };
    const target = fixture({ prompt: firstPrompt });
    const ui = await mounted(target);
    try {
      await ui.send("n");
      // React can batch the controller's old-prompt cleanup and next-prompt publication.
      target.publish({ prompt: undefined });
      await ui.update({ prompt: nextPrompt });
      await ui.send("\r");
      expect(target.answers).toEqual([true]);
    } finally {
      ui.close();
    }
  });

  test("login credentials stay masked while grapheme edits preserve the real input", async () => {
    const target = fixture({ prompt: { kind: "secret", title: "BAAS 登录 Key" } });
    const ui = await mounted(target);
    try {
      await ui.send("key-a界👩‍💻b");
      await ui.send("\x1b[D");
      await ui.send("\x7f");
      await ui.send("🔑");
      expect(ui.frames.join("\n")).not.toContain("key-a");
      expect(ui.frame).toContain("•");
      await ui.send("\r");
      expect(target.answers).toEqual(["key-a界🔑b"]);
    } finally {
      ui.close();
    }
  });

  test("Ctrl+C cancels a credential prompt without submitting or recording it", async () => {
    const target = fixture({ prompt: { kind: "secret", title: "BAAS 登录 Key" } });
    const ui = await mounted(target);
    try {
      await ui.send("secret-input");
      await ui.send("\x03");
      expect(target.cancelled).toBe(1);
      expect(target.answers).toEqual([]);
      expect(target.commands).toEqual([]);
      expect(ui.frame).not.toContain("secret-input");
    } finally {
      ui.close();
    }
  });

  test("credentials never flash in plaintext when the controller dismisses a prompt", async () => {
    const target = fixture({ prompt: { kind: "secret", title: "BAAS 登录 Key" } });
    const ui = await mounted(target);
    try {
      await ui.send("secret-key-from-expired-prompt");
      await ui.update({ prompt: undefined });
      expect(ui.frames.join("\n")).not.toContain("secret-key-from-expired-prompt");
    } finally {
      ui.close();
    }
  });

  test("a masked credential remains on its input row without overwriting the border", async () => {
    const target = fixture({ prompt: { kind: "secret", title: "BAAS 登录 Key" } });
    const ui = await mounted(target);
    try {
      const credential = "a-long-credential-with-symbols";
      await ui.send(credential);
      const inputLine = ui.frame.split("\n").find((line) => line.includes("❯")) || "";
      expect(inputLine).toContain("•".repeat(credential.length));
      expect(ui.frame.split("\n").filter((line) => line.includes("•"))).toHaveLength(1);
    } finally {
      ui.close();
    }
  });

  test("Delete removes the grapheme after the cursor rather than the previous one", async () => {
    const target = fixture();
    const ui = await mounted(target);
    try {
      await ui.send("abc");
      await ui.send("\x1b[D");
      await ui.send("\x1b[3~");
      await ui.send("\r");
      expect(target.commands).toEqual(["ab"]);
    } finally {
      ui.close();
    }
  });

  test("long approval details retain visible confirmation choices on small terminals", async () => {
    const target = fixture({
      prompt: {
        kind: "confirm",
        title: "确认提交 BAAS 操作",
        detail: JSON.stringify(
          { changes: Array.from({ length: 30 }, (_, i) => `字段${i}`) },
          null,
          2
        ),
      },
    });
    const ui = await mounted(target, { columns: 40, rows: 16 });
    try {
      expect(ui.frame).toContain("确认执行 [y]");
      expect(ui.frame).toContain("取消 [n]");
    } finally {
      ui.close();
    }
  });

  test("opening a redacted configuration value cannot submit its placeholder unchanged", async () => {
    const target = fixture();
    target.setConfig({ service: { api_key: "[REDACTED]" } });
    const ui = await mounted(target);
    try {
      await ui.send("/config");
      await ui.send("\r");
      await ui.send("\r");
      await ui.send("\r");
      expect(target.writes).toEqual([]);
    } finally {
      ui.close();
    }
  });

  test("unexposed internal configuration secrets never become selectable", async () => {
    const target = fixture();
    target.setConfig({ service: { api_key: "[REDACTED]" } });
    const ui = await mounted(target);
    try {
      await ui.send("/config");
      await ui.send("\r");
      expect(ui.frame).not.toContain("/service/api_key");
      expect(target.writes).toEqual([]);
    } finally {
      ui.close();
    }
  });
});

describe("workspace rendering", () => {
  test("the log divider captures drags, clamps pane widths and keeps its ratio on resize", async () => {
    const target = fixture();
    const ui = await mounted(target, { columns: 120, rows: 36 });
    const divider = () => {
      const lines = ui.frame.split("\n");
      const y = lines.findIndex((line) => /[│┃] 运行日志/.test(line));
      expect(y).toBeGreaterThanOrEqual(0);
      const index = lines[y].search(/[│┃]/);
      return { x: displayWidth(lines[y].slice(0, index)), y };
    };
    const drag = (kind: MouseEvent["kind"], x: number, y: number) =>
      ui.mouseEvent({ kind, button: 0, x, y, delta: 0 });
    try {
      await ui.send("/start");
      await ui.send("\r");
      await ui.waitForFrame("│ 运行日志");
      const initial = divider();
      expect(initial.x).toBe(67);
      await drag("press", initial.x, initial.y);
      expect(ui.mouse.hasCapture).toBe(true);
      await drag("drag", 80, initial.y);
      expect(divider().x).toBe(80);
      expect(ui.frame).toContain("┃");
      // Captured motion can cross the tabs and both pane edges without clicking them.
      await drag("drag", 0, 0);
      expect(divider().x).toBe(40);
      await drag("drag", 999, 0);
      expect(divider().x).toBe(89);
      await drag("release", 80, 0);
      expect(ui.mouse.hasCapture).toBe(false);
      expect(divider().x).toBe(80);
      expect(ui.frame).not.toContain("┃");
      expect(target.commands).toEqual(["start"]);
      await drag("drag", 45, initial.y);
      expect(divider().x).toBe(80);
      await ui.resize(150);
      expect(divider().x).toBe(100);
      await ui.resize(90);
      expect(ui.frame).not.toMatch(/[│┃] 运行日志/);
      await ui.resize(120);
      expect(divider().x).toBe(80);
      const restored = divider();
      await drag("press", restored.x, restored.y);
      await ui.update({ busy: "正在刷新" });
      expect(ui.mouse.hasCapture).toBe(false);
      await ui.update({ busy: undefined });
      expect(divider().x).toBe(80);
      for (const line of ui.frame.trimEnd().split("\n"))
        expect(displayWidth(line)).toBeLessThanOrEqual(120);
    } finally {
      ui.close();
      expect(ui.mouse.hasCapture).toBe(false);
    }
  });

  test.each([
    { columns: 24, rows: 12 },
    { columns: 40, rows: 14 },
  ])(
    "small terminal command suggestions always show the action Enter selects: %j",
    async ({ columns, rows }) => {
      const target = fixture();
      const ui = await mounted(target, { columns, rows });
      try {
        await ui.send("/");
        expect(ui.frame).toContain("❯ /scheduler");
        await ui.send("\x1b[B");
        expect(ui.frame).toContain("❯ /update");
        const lines = ui.frame.trimEnd().split("\n");
        expect(lines.length).toBeLessThanOrEqual(rows);
        expect(lines.filter((line) => displayWidth(line) > columns)).toEqual([]);
        await ui.send("\r");
        expect(target.commands).toEqual(["update"]);
      } finally {
        ui.close();
      }
    }
  );

  test("narrow lists put readable labels above details and retain keyboard selection", async () => {
    const target = fixture({
      tasks: {
        cafe: { event_name: "咖啡厅的每日自动摸头任务", enabled: true },
        mail: { event_name: "领取邮件", enabled: true },
      },
    });
    const ui = await mounted(target, { columns: 40, rows: 25 });
    try {
      await ui.send("/tasks");
      await ui.send("\r");
      const lines = ui.frame.trimEnd().split("\n");
      const label = lines.findIndex((line) => line.includes("咖啡厅的每日自动摸头任务"));
      expect(label).toBeGreaterThan(0);
      expect(lines[label + 1]).toContain("cafe");
      expect(lines.length).toBeLessThanOrEqual(25);
      expect(lines.filter((line) => displayWidth(line) > 40)).toEqual([]);
      await ui.send("\x1b[B");
      expect(ui.frame).toContain("❯ 领取邮件");
    } finally {
      ui.close();
    }
  });

  test("short terminals reserve room for configuration choices and input", async () => {
    const target = fixture();
    target.setConfig({ screenshot_method: "adb", server: "官服" });
    const ui = await mounted(target, { columns: 40, rows: 14 });
    try {
      await ui.send("/config");
      await ui.send("\r");
      expect(ui.frame).toContain("配置分类");
      expect(ui.frame).toContain("键入名称筛选");
      const lines = ui.frame.trimEnd().split("\n");
      expect(lines.length).toBeLessThanOrEqual(14);
      expect(lines.filter((line) => displayWidth(line) > 40)).toEqual([]);
    } finally {
      ui.close();
    }
  });

  test("configuration profile names cannot emit terminal control sequences in the footer", async () => {
    const target = fixture({
      profiles: { "sensei-cn": "配置档\x1b]52;c;clipboard-secret\x07" },
    });
    const ui = await mounted(target);
    try {
      expect(ui.rawFrame).not.toContain("clipboard-secret");
    } finally {
      ui.close();
    }
  });

  test("the home header is an open six-row brand block with fixed bottom input", async () => {
    const ui = await mounted(fixture(), { columns: 100, rows: 36 });
    try {
      const lines = ui.frame.split("\n");
      const tabs = lines.findIndex((line) => line.includes("总览") && line.includes("配置"));
      expect(tabs).toBe(6);
      expect(lines[0]?.trim()).toBe("");
      expect(lines[1]).toContain(`BAASX v${manifest.version}`);
      expect(lines.slice(0, tabs).join("\n")).not.toMatch(/[╭╮╰╯│]/);
      expect(lines.filter((line) => displayWidth(line) > 100)).toEqual([]);
      expect(lines.findIndex((line) => line.includes("输入 /"))).toBeGreaterThan(29);
      expect(ui.frame).toContain("Ctrl+R");
    } finally {
      ui.close();
    }
  });

  test("short confirmations sit above the input while long details retain visible choices", async () => {
    const target = fixture({
      prompt: { kind: "confirm", title: "确认提交 BAAS 操作", detail: "活动挑战" },
    });
    const ui = await mounted(target);
    try {
      const lines = ui.frame.split("\n");
      const prompt = lines.findIndex((line) => line.includes("确认提交 BAAS 操作"));
      expect(prompt).toBeGreaterThan(15);
      expect(lines[prompt + 1]).toContain("确认执行 [y]");
      expect(lines[prompt + 2]).toContain("活动挑战");
      await ui.send("n");
      await ui.send("\r");
      expect(target.answers).toEqual([false]);
    } finally {
      ui.close();
    }
  });

  test("the newest activity stays visible when activity details occupy multiple rows", async () => {
    const activity = Array.from({ length: 25 }, (_, i) => ({
      id: `event-${i}`,
      title: `操作记录 ${i}`,
      detail: `详细内容 ${i}`,
      tone: "info" as const,
    }));
    const ui = await mounted(fixture({ activity }));
    try {
      expect(ui.frame).toContain("操作记录 24");
      expect(ui.frame).toContain("详细内容 24");
    } finally {
      ui.close();
    }
  });

  test("very small terminals never render outside the actual terminal cell dimensions", async () => {
    const ui = await mounted(fixture(), { columns: 16, rows: 9 });
    try {
      const lines = ui.frame.trimEnd().split("\n");
      expect(lines.length).toBeLessThanOrEqual(9);
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(16);
    } finally {
      ui.close();
    }
  });
});
