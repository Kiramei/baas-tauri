import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalText } from "../src/ui";

test.skipIf(process.platform === "win32" || typeof Bun.Terminal !== "function")(
  "real terminal supports mouse task activation, yes default, log wheel scrolling, colors and terminal restoration",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "baas-mouse-"));
    let output = "";
    const decoder = new TextDecoder();
    const terminal = new Bun.Terminal({
      cols: 120,
      rows: 36,
      data(_, data) {
        output += decoder.decode(data, { stream: true });
      },
    });
    const child = Bun.spawn(
      [process.execPath, "cli/src/index.ts", "--demo", "--lang", "zh", "--config-home", directory],
      {
        terminal,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          FORCE_COLOR: undefined,
          NO_COLOR: undefined,
          BAAS_PROFILE: undefined,
        },
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
          throw Error(`Missing ${value}: ${text.slice(-6000)}`);
        await Bun.sleep(15);
      }
    };
    const key = async (value: string) => {
      terminal.write(value);
      await Bun.sleep(100);
    };
    try {
      await until("连接已建立");
      expect(output).toContain("\x1b[?1049h");
      expect(output).toContain("\x1b[?1006h");
      expect(output).toContain("\x1b[38;2;");
      await key("/tasks");
      await key("\r");
      await until("任务列表");
      // Compact header: four rows, one spacer, tabs, list title, then task rows.
      await key("\x1b[<0;12;9M");
      await key("\x1b[<0;12;9m");
      await until("确认提交 BAAS 操作");
      await key("\r");
      await until("后台正在执行");
      await until("已完成");
      expect(terminalText(output)).toContain("运行日志");
      await key("\x1b[<64;110;18M");
      await until("已暂停跟随");
      await key("\x04");
      expect(await child.exited).toBe(0);
      expect(output).toContain("\x1b[?1006l");
      expect(output).toContain("\x1b[?1049l");
      expect(terminalText(output)).not.toContain("0;12;9");
    } finally {
      if (child.exitCode === null) child.kill();
      terminal.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20000
);
