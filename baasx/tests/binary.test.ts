import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalText } from "../src/ui";

// Source tests cannot detect a dependency reaching an API removed by --trim.
// CI runs these checks against the actual native artifact on every platform.
const executable = process.env.BAASX_TEST_BINARY;

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
  }
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
    let cursor = 0;
    const until = async (value: string) => {
      const deadline = Date.now() + 8000;
      for (;;) {
        const text = terminalText(output);
        const index = text.indexOf(value, cursor);
        if (index >= 0) {
          cursor = index + value.length;
          return;
        }
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(`Compiled terminal missing ${value}: ${text.slice(-6000)}`);
        await Bun.sleep(20);
      }
    };
    const key = async (value: string) => {
      terminal.write(value);
      await Bun.sleep(100);
    };
    try {
      await until("已连接");
      await until("输入 /");
      await key("/config");
      await key("\r");
      await key("screenshot_method");
      await key("\r");
      await until("保存");
      await key("\x1b[B");
      await key("\r");
      await until("确认提交 BAAS 操作");
      await key("\r");
      await until("配置已保存");
      await key("/config");
      await key("\r");
      await key("createPriority_phase1");
      await key("\r");
      await until("上移");
      await key("\x1b[C");
      await key("\x13");
      await until("确认提交 BAAS 操作");
      await key("\r");
      await until("配置已保存");
      await key("/oneoff");
      await key("\r");
      await key("start_explore_activity_challenge");
      await key("\r");
      await until("确认提交 BAAS 操作");
      await key("n");
      await key("\r");
      await until("未提交");
      await key("/help");
      await key("\r");
      await until("命令说明与快捷键");
      await until("只运行指定任务一次");
      await key("\x1b[6~");
      await key("/reload");
      await key("\r");
      await until("工作台已重载");
      expect(terminalText(output)).toContain("项任务");
      await key("\x12");
      await until("工作台已重载");
      await key("\x04");
      expect(await child.exited).toBe(0);
      expect(output).toContain("\x1b[?1049l");
    } finally {
      if (child.exitCode === null) child.kill();
      terminal.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  25000
);
