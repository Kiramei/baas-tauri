import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalText } from "../src/ui";

// Source tests cannot detect a dependency reaching an API removed by --trim.
// CI runs these checks against the actual native artifact on every platform.
const executable = process.env.BAASX_TEST_BINARY;
const timeoutScale = process.env.BAASX_TEST_EMULATED === "1" ? 4 : 1;

test.skipIf(!executable)(
  "compiled CLI supports direct start without confirmation, configuration and packs",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "baasx-binary-"));
    const run = async (...args: string[]) => {
      const child = Bun.spawn(
        [
          executable!,
          "--demo",
          "--json",
          "--profile",
          "sensei-cn",
          "--config-home",
          directory,
          ...args,
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return JSON.parse(stdout);
    };
    try {
      expect((await run("status"))["sensei-cn"].running).toBe(false);
      expect(await run("start")).toMatchObject({ accepted: true, completed: false });
      expect(await run("--dry-run", "start")).toMatchObject({
        dry_run: true,
        action: "scheduler_start",
      });
      expect(await run("--yes", "run", "start_explore_activity_story")).toMatchObject({
        accepted: true,
      });
      expect(await run("--yes", "config", "set", "/screenshot_method", '"scrcpy"')).toMatchObject({
        saved: true,
        value: "scrcpy",
      });
      expect(await run("config", "get", "/screenshot_method")).toBe("adb");
      expect((await run("packs"))[0].id).toBe("baas-core");
      expect(await run("--help")).toHaveProperty("help");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  timeoutScale === 1 ? 5000 : 60000
);

test.skipIf(!executable || process.platform === "win32" || typeof Bun.Terminal !== "function")(
  "compiled terminal opens configuration and saves an edited enum with its WASM layout engine",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "baasx-binary-pty-"));
    let output = "";
    const decoder = new TextDecoder();
    const terminal = new Bun.Terminal({
      cols: 110,
      rows: 36,
      data(_, data) {
        output += decoder.decode(data, { stream: true });
      },
    });
    const child = Bun.spawn([executable!, "--demo", "--lang", "zh", "--config-home", directory], {
      terminal,
      env: {
        ...process.env,
        CI: "true",
        CONTINUOUS_INTEGRATION: "true",
        TERM: "xterm-256color",
        NO_COLOR: "1",
        BAAS_PROFILE: undefined,
      },
    });
    const currentFrame = (after: number) => {
      const start = output.lastIndexOf("\x1b[H");
      if (start < after) return;
      const frame = output.slice(start);
      // Fullscreen output addresses every row. Do not acknowledge a partial or historical frame.
      if (frame.split("\x1b[2K").length - 1 < 36) return;
      return terminalText(frame);
    };
    const until = async (label: string, matches: (frame: string) => boolean, after = 0) => {
      const deadline = Date.now() + 8000 * timeoutScale;
      for (;;) {
        const frame = currentFrame(after);
        if (frame && matches(frame)) return frame;
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(
            `Compiled terminal missing ${label}: ${terminalText(output).slice(-6000)}`
          );
        await Bun.sleep(20);
      }
    };
    const inputIs = (value: string) => (frame: string) =>
      frame.split("\n").some((line) => line.trim() === `❯ ${value}`);
    const contains = (text: string) => (frame: string) => frame.includes(text);
    const ready = (frame: string) => /^\s*❯\s+(?:输入 \/|键入名称筛选 · \/ 打开命令)/m.test(frame);
    const key = async (value: string, label: string, matches: (frame: string) => boolean) => {
      const after = output.length;
      terminal.write(value);
      return until(label, matches, after);
    };
    const command = (value: string) =>
      key(
        value,
        `command input ${value}`,
        (frame) => inputIs(value)(frame) && frame.includes("Tab 补全 · Enter 执行")
      );
    const saved = (frame: string) =>
      frame.includes("配置已保存") && !frame.includes("确认提交 BAAS 操作") && ready(frame);
    const reloaded = (frame: string) =>
      frame.includes("工作台已重载") && !frame.includes("命令说明与快捷键") && ready(frame);
    try {
      await until("connected input", (frame) => frame.includes("已连接") && ready(frame));
      await command("/config");
      await key("\r", "configuration categories", contains("配置分类"));
      await key(
        "screenshot_method",
        "screenshot search",
        (frame) => inputIs("screenshot_method")(frame) && frame.includes("截图方式")
      );
      await key(
        "\r",
        "enum editor",
        (frame) =>
          frame.includes("截图方式") &&
          frame.includes("❯ ● ADB") &&
          frame.includes("保存 [Ctrl+S]") &&
          frame.includes("↑↓ 选择 · Enter 确认")
      );
      await key("\x1b[B", "scrcpy selection", contains("❯ ● scrcpy"));
      await key("\r", "enum confirmation", contains("确认提交 BAAS 操作"));
      await key("\r", "saved enum", saved);
      await command("/config");
      await key("\r", "configuration categories", contains("配置分类"));
      await key("createPriority_phase1", "priority search", inputIs("createPriority_phase1"));
      await key("\r", "priority editor", contains("上移"));
      await key("\x1b[C", "moved priority", contains("❯ 2. 花"));
      await key("\x13", "priority confirmation", contains("确认提交 BAAS 操作"));
      await key("\r", "saved priority", saved);
      await command("/oneoff");
      await key("\r", "one-off task list", contains("一次性任务"));
      await key(
        "start_explore_activity_challenge",
        "one-off search",
        inputIs("start_explore_activity_challenge")
      );
      await key("\r", "one-off confirmation", contains("确认提交 BAAS 操作"));
      await key("n", "declined confirmation", inputIs("n"));
      await key(
        "\r",
        "cancelled one-off",
        (frame) => frame.includes("未提交") && !frame.includes("确认提交 BAAS 操作") && ready(frame)
      );
      await command("/help");
      const help = await key(
        "\r",
        "workbench help",
        (frame) => frame.includes("命令说明与快捷键") && frame.includes("只运行指定任务一次")
      );
      const page = (frame: string) => /PgUp \/ PgDn · ([^\n]+)/.exec(frame)?.[1];
      await key("\x1b[6~", "scrolled help", (frame) => !!page(frame) && page(frame) !== page(help));
      // Help itself mentions /reload. Require its exact input row and candidate menu before Enter.
      await command("/reload");
      await key("\r", "reloaded workbench", reloaded);
      expect(terminalText(output)).not.toContain("/logs 查看日志");
      await command("/help");
      await key("\r", "help before Ctrl+R", contains("命令说明与快捷键"));
      await key("\x12", "Ctrl+R reload leaving help", reloaded);
      terminal.write("\x04");
      expect(await child.exited).toBe(0);
      expect(output).toContain("\x1b[?1049l");
    } finally {
      if (child.exitCode === null) child.kill();
      terminal.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  25000 * timeoutScale
);
