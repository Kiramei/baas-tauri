import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import { terminalText } from "../src/ui";
import { WorkspaceView } from "../src/workspace-view";
import type { Workspace, WorkspaceSnapshot } from "../src/workspace";

test("dismissing a no confirmation clears its input in the same committed frame", async () => {
  let state: WorkspaceSnapshot = {
    version: "0.1.0",
    endpoint: "演示环境",
    demo: true,
    connected: true,
    connecting: false,
    profile: "sensei-cn",
    profiles: { "sensei-cn": "老师的配置" },
    tasks: {},
    status: {},
    logs: [],
    activity: [],
    busy: "运行任务",
    prompt: { id: "decline", kind: "confirm", title: "确认提交 BAAS 操作" },
    readOnly: false,
    dryRun: false,
    packs: [],
  };
  let listener: ((snapshot: WorkspaceSnapshot) => void) | undefined;
  const answers: unknown[] = [];
  const workspace = {
    get snapshot() {
      return structuredClone(state);
    },
    subscribe(next: (snapshot: WorkspaceSnapshot) => void) {
      listener = next;
      next(structuredClone(state));
      return () => {
        listener = undefined;
      };
    },
    answerPrompt(value: unknown) {
      answers.push(value);
      state = {
        ...state,
        prompt: undefined,
        busy: undefined,
        activity: [{ id: "declined", title: "未提交", tone: "info" }],
      };
      listener?.(structuredClone(state));
    },
  } as unknown as Workspace;
  const frames: string[] = [];
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        frames.push(terminalText(String(chunk)));
        callback();
      },
    }),
    { columns: 100, rows: 36, isTTY: true }
  );
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const app = render(React.createElement(WorkspaceView, { workspace }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  const untilFrame = async (predicate: (frame: string) => boolean) => {
    const deadline = Date.now() + 3000;
    while (!frames.some(predicate)) {
      if (Date.now() > deadline) throw new Error(`Missing workspace frame: ${frames.at(-1)}`);
      await Bun.sleep(5);
    }
  };
  try {
    await untilFrame((frame) => frame.includes("❯ y"));
    stdin.write("n");
    await untilFrame((frame) => frame.includes("❯ n"));
    stdin.write("\r");
    await untilFrame((frame) => frame.includes("未提交"));
    expect(answers).toEqual([false]);
    // Examine every commit, including the one before passive effects reset input.
    const dismissed = frames.filter((frame) => frame.includes("未提交"));
    expect(dismissed.length).toBeGreaterThan(0);
    for (const frame of dismissed) expect(frame).not.toContain("❯ n\n");
  } finally {
    app.unmount();
    app.cleanup();
    stdin.destroy();
    stdout.destroy();
  }
});

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
      [process.execPath, "baasx/src/index.ts", "--demo", "--no-color", "--config-home", directory],
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
      // Wait for this input to commit rather than assuming a render delay.
      await until(` ❯ ${value}\n`);
      terminal.write("\r");
    };
    try {
      await until("连接已建立");
      terminal.write("/");
      await until("编辑任务调度");
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
      terminal.write("n");
      await until(" ❯ n\n");
      terminal.write("\r");
      await until("操作已取消 · 未提交的新操作已取消");
      await command("/run mail");
      await until("确认提交 BAAS 操作");
      // Confirm the default Yes; wait until the prompt has committed it.
      await until(" ❯ y\n");
      terminal.write("\r");
      await until("已完成");
      await command("/logs");
      await until("运行日志");
      terminal.resize(45, 18);
      await Bun.sleep(180);
      terminal.write("\x1b");
      await Bun.sleep(70);
      await command("status");
      await until("运行状态");
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
