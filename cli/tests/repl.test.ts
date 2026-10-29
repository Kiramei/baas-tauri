import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalText } from "../src/ui";

test.skipIf(process.platform === "win32" || typeof Bun.Terminal !== "function")(
  "terminal workspace selects profiles, filters tasks, confirms runs and stays usable after resize",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "baas-workspace-pty-"));
    await writeFile(join(directory, "settings.json"), JSON.stringify({ profile: "real-profile" }));
    let output = "";
    const decoder = new TextDecoder();
    const terminal = new Bun.Terminal({
      cols: 100,
      rows: 36,
      data(_, data) {
        output += decoder.decode(data, { stream: true });
      },
    });
    const child = Bun.spawn(
      [process.execPath, "cli/src/index.ts", "--demo", "--no-color", "--config-home", directory],
      {
        terminal,
        env: {
          ...process.env,
          BAAS_PROFILE: undefined,
          BAAS_LANG: "zh",
          NO_COLOR: "1",
          TERM: "xterm-256color",
        },
      }
    );
    let cursor = 0;
    const until = async (text: string, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const clean = terminalText(output);
        const position = clean.indexOf(text, cursor);
        if (position >= 0) {
          cursor = position + text.length;
          return;
        }
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(`Workspace did not reach ${text}: ${clean.slice(-12000)}`);
        await Bun.sleep(15);
      }
    };
    const command = async (value: string) => {
      terminal.write(value);
      await Bun.sleep(80);
      terminal.write("\r");
      await Bun.sleep(100);
    };
    try {
      await until("连接已建立");
      terminal.write("/");
      await until("选择并运行任务");
      terminal.write("\x1b");
      await Bun.sleep(70);
      await command("/profiles");
      await until("配置档 · Enter 切换");
      terminal.write("\x1b[B");
      await Bun.sleep(70);
      terminal.write("\r");
      await until("已选择配置档");
      await until("夏莱 · 日服");
      await command("/tasks");
      await until("任务列表 · Enter 运行");
      terminal.write("邮件");
      await Bun.sleep(70);
      terminal.write("\r");
      await until("确认提交 BAAS 操作");
      terminal.write("\r");
      await until("未提交");
      await command("/run mail");
      await until("确认提交 BAAS 操作");
      terminal.write("y");
      await Bun.sleep(70);
      terminal.write("\r");
      await until("已完成");
      await command("/logs");
      await until("运行日志");
      terminal.resize(45, 18);
      await Bun.sleep(180);
      terminal.write("\x1b");
      await Bun.sleep(70);
      await command("status");
      await until("空闲");
      terminal.write("\x04");
      expect(await child.exited).toBe(0);
      const text = terminalText(output);
      expect(text).not.toContain("BAAS_AI");
      expect(text).not.toContain("real-profile");
      expect(text).toContain("mail");
    } finally {
      if (child.exitCode === null) child.kill();
      terminal.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000
);
