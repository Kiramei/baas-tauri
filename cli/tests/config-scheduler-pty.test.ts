import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalText } from "../src/ui";

test.skipIf(process.platform === "win32" || typeof Bun.Terminal !== "function")(
  "terminal edits typed configuration and scheduler values, retaining drafts across a declined confirmation",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "baas-controls-pty-"));
    let output = "";
    const decoder = new TextDecoder();
    const terminal = new Bun.Terminal({
      cols: 110,
      rows: 36,
      data(_, data) {
        output += decoder.decode(data, { stream: true });
      },
    });
    const child = Bun.spawn(
      [process.execPath, "cli/src/index.ts", "--demo", "--lang", "zh", "--config-home", directory],
      {
        terminal,
        env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1", BAAS_PROFILE: undefined },
      }
    );
    let cursor = 0;
    const until = async (value: string) => {
      const deadline = Date.now() + 6000;
      for (;;) {
        const text = terminalText(output),
          index = text.indexOf(value, cursor);
        if (index >= 0) {
          cursor = index + value.length;
          return;
        }
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(`Missing ${value}: ${text.slice(-8000)}`);
        await Bun.sleep(15);
      }
    };
    const key = async (value: string) => {
      terminal.write(value);
      await Bun.sleep(100);
    };
    const command = async (value: string) => {
      await key(value);
      await key("\r");
    };
    try {
      await until("连接已建立");
      await command("/config");
      await key("screenshot_method");
      await key("\r");
      await until("保存");
      await key("\x1b[B");
      await key("\r");
      await until("确认提交 BAAS 操作");
      await key("n");
      await key("\r");
      await until("未提交");
      await key("\x13");
      await until("确认提交 BAAS 操作");
      await until("scrcpy");
      await key("\r");
      await until("配置已保存");
      await command("/scheduler");
      await key("cafe");
      await key("\r");
      await key("priority");
      await key("\r");
      await until("数字");
      await key("42");
      await key("\r");
      await until("确认修改调度");
      await key("\r");
      await until("调度已保存");
      await key("priority");
      await key("\r");
      await until("42");
      await key("\x1b");
      await command("/run cafe");
      await until("确认提交 BAAS 操作");
      await key("\r");
      await until("后台正在执行");
      await until("已完成");
      expect(terminalText(output)).toContain("运行日志");
      await key("\x04");
      expect(await child.exited).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
      terminal.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  25000
);
