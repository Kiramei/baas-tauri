import React from "react";
import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { configChoices, filterChoices, WorkspaceView } from "../src/workspace-view";
import type { Workspace, WorkspaceSnapshot } from "../src/workspace";
import { displayWidth, terminalText } from "../src/ui";

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
  let cancelled = 0;
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
    async connect() {},
    async selectProfile() {},
    async run() {},
    async execute(command: string) {
      commands.push(command);
    },
    async getConfig() {
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
    publish,
    setConfig: (value: Record<string, unknown>) => (configuration = value),
    get cancelled() {
      return cancelled;
    },
  };
}

async function mounted(
  target: ReturnType<typeof fixture>,
  options: { columns?: number; rows?: number } = {}
) {
  const frames: string[] = [];
  const rawFrames: string[] = [];
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        const frame = terminalText(String(chunk));
        if (frame.includes("baax")) {
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
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const app = render(<WorkspaceView workspace={target.workspace} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
    maxFps: 1000,
  });
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 35));
  await settle();
  return {
    get frame() {
      return frames.at(-1) || "";
    },
    get frames() {
      return [...frames];
    },
    get rawFrame() {
      return rawFrames.at(-1) || "";
    },
    async send(input: string) {
      stdin.write(input);
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

  test("the welcome card top and bottom borders align at wide terminal widths", async () => {
    const ui = await mounted(fixture(), { columns: 100, rows: 36 });
    try {
      const lines = ui.frame.split("\n");
      const top = lines.find((line) => line.startsWith("╭"));
      const bottom = lines.find((line) => line.startsWith("╰"));
      expect(top).toBeDefined();
      expect(bottom).toBeDefined();
      expect(displayWidth(top || "")).toBe(displayWidth(bottom || ""));
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
