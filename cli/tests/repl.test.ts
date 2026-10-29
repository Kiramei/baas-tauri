import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalText } from "../src/ui";

test.skipIf(process.platform === "win32" || typeof Bun.Terminal !== "function")(
  "full REPL preserves selection, wait results, flag scope and input ownership after cancellation",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "baas-repl-"));
    // Desktop/service preferences must not select an invalid profile in the demo sandbox.
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({ url: "ws://localhost:8190", profile: "real-server-profile" })
    );
    let output = "";
    const decoder = new TextDecoder();
    const terminal = new Bun.Terminal({
      cols: 100,
      rows: 30,
      data(_terminal, data) {
        output += decoder.decode(data, { stream: true });
      },
    });
    const child = Bun.spawn(
      [process.execPath, "cli/src/index.ts", "--demo", "--no-color", "--config-home", directory],
      { terminal, env: { ...process.env, BAAS_PROFILE: undefined, NO_COLOR: "1" } }
    );
    let cursor = 0;
    const until = async (text: string, timeout = 4000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const position = output.indexOf(text, cursor);
        if (position >= 0) {
          cursor = position + text.length;
          return;
        }
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(`REPL did not reach ${JSON.stringify(text)}: ${terminalText(output)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      await until("sensei-cn ❯");
      terminal.write("/use\n");
      await until("选择配置档");
      terminal.write("\x1b[B\r");
      await until("sensei-jp ❯");
      terminal.write("/daily --read-only\n");
      await until("未执行任何步骤");
      await until("sensei-jp ❯");
      terminal.write("/daily --dry-run\n");
      await until('"steps": [');
      await until("sensei-jp ❯");
      terminal.write("/start --read-only\n");
      await until("只读模式");
      await until("sensei-jp ❯");
      terminal.write("/start --yes\n");
      await until('"accepted": true');
      await until("sensei-jp ❯");
      terminal.write("/stop --yes\n");
      await until('"status": "stopped"');
      await until("sensei-jp ❯");
      terminal.write("/run mail --wait --follow\n");
      await until("提交以上操作？");
      terminal.write("y\n");
      await until('"completed": true');
      await until('"succeeded": true');
      await until("sensei-jp ❯");
      terminal.write("/start --dry-run\n");
      await until('"dry_run": true');
      await until("sensei-jp ❯");
      terminal.write("/start\n");
      await until("提交以上操作？");
      terminal.write("n\n");
      await until("未提交到后端");
      await until("sensei-jp ❯");
      terminal.write("/logs --follow\n");
      await until("演示任务执行完成");
      terminal.write("\x03");
      await until("已取消本次等待/请求");
      await until("sensei-jp ❯");
      terminal.write("/status\n");
      await until("空闲");
      await until("sensei-jp ❯");
      terminal.write("/quit\n");
      expect(await child.exited).toBe(0);
      expect(terminalText(output)).toContain("演示开始：mail");
      expect(terminalText(output)).not.toContain("real-server-profile ❯");
    } finally {
      if (child.exitCode === null) child.kill();
      terminal.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000
);
