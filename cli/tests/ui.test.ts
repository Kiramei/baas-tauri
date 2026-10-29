import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import {
  TerminalTextSanitizer,
  TerminalUI,
  displayWidth,
  terminalText,
  truncateText,
} from "../src/ui.ts";

function capture(columns = 80, isTTY = false) {
  let output = "";
  const stream = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        output += chunk.toString();
        done();
      },
    }),
    { columns, isTTY }
  ) as unknown as NodeJS.WriteStream;
  return { stream, text: () => output };
}

async function ptyInput(body: string, ready: string, keys?: string) {
  let output = "";
  let sent = false;
  const decoder = new TextDecoder();
  let completed!: (value: Record<string, unknown>) => void;
  const checked = new Promise<Record<string, unknown>>((resolve) => {
    completed = resolve;
  });
  const terminal = new Bun.Terminal({
    cols: 24,
    rows: 12,
    data(term, data) {
      output += decoder.decode(data, { stream: true });
      if (keys !== undefined && !sent && output.includes(ready)) {
        sent = true;
        term.write(keys);
      }
      const match = /CHECK(\{[^\r\n]*\})[\r\n]/.exec(output);
      if (match) completed(JSON.parse(match[1]));
    },
  });
  const source = `
    import { TerminalUI } from ${JSON.stringify(new URL("../src/ui.ts", import.meta.url).href)};
    const ui = new TerminalUI();
    process.stdin.pause();
    const before={raw:Boolean(process.stdin.isRaw),paused:process.stdin.isPaused(),listeners:process.stdin.listenerCount("keypress")};
    const controller=new AbortController();
    const options={title:"选择配置档",items:[{value:"first",label:"国服主号",description:"每日课程与咖啡厅"},{value:"second",label:"国际服副号",description:"很长的中文说明应当按终端单元截断显示"}],initial:"first"};
    let result=null,error=null,matched=null;
    ${body}
    console.log("CHECK"+JSON.stringify({result:result??null,error,matched,raw:Boolean(process.stdin.isRaw),paused:process.stdin.isPaused(),listeners:process.stdin.listenerCount("keypress"),before}));
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    terminal,
    env: { ...process.env, NO_COLOR: "1", TERM: "xterm-256color" },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [code, check] = await Promise.race([
      Promise.all([child.exited, checked]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`PTY input timed out: ${output}`)), 3000);
      }),
    ]);
    expect(code).toBe(0);
    const before = check.before as Record<string, unknown>;
    for (const field of ["raw", "paused", "listeners"]) expect(check[field]).toBe(before[field]);
    // eslint-disable-next-line no-control-regex -- NO_COLOR permits cursor movement, but excludes styled text.
    expect(output).not.toMatch(/\x1b\[(?:3[0-7]|[12])m/);
    for (const line of terminalText(output).split("\n"))
      if (!line.startsWith("CHECK")) expect(displayWidth(line)).toBeLessThanOrEqual(24);
    return { check, output };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    terminal.close();
  }
}

describe("terminal safety and layout", () => {
  test("strips cursor moves, hyperlinks, clipboard writes and C0/C1 controls", () => {
    const attack =
      "before\x1b[2J\x1b[H\x1b]52;c;secret\x07\x1b]8;;https://evil.invalid\x07label\x1b]8;;\x07\r\b\x00\u009b31m\u202eafter";
    const safe = terminalText(attack);
    expect(safe).toContain("before");
    expect(safe).toContain("label");
    expect(safe).toContain("after");
    // eslint-disable-next-line no-control-regex -- Verify control-byte removal, including malicious backend text.
    expect(safe).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/);
    expect(safe).not.toContain("https://evil.invalid");
    expect(safe).not.toContain("secret");
  });

  test("measures CJK, combining marks, emoji clusters and flags in terminal cells", () => {
    expect(displayWidth("BAAS 日常")).toBe(9);
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(displayWidth("🇨🇳")).toBe(2);
    expect(displayWidth("\x1b[36m你好\x1b[0m")).toBe(4);
    expect(truncateText("你好世界", 5)).toBe("你好…");
    expect(displayWidth(truncateText("👩‍💻你好世界", 4))).toBeLessThanOrEqual(4);
  });

  test("welcome and CJK tables fit a narrow viewport", () => {
    const output = capture(28);
    const ui = new TerminalUI({ output: output.stream, color: false });
    ui.welcome({
      version: "0.1.0",
      endpoint: "ws://127.0.0.1:8190",
      profile: "老师的配置档",
      connected: true,
    });
    ui.table(
      ["配置档", "状态", "当前任务"],
      [
        ["国服主号", "运行中", "咖啡厅每日课程安排"],
        ["国际服", "空闲", "—"],
      ]
    );
    expect(output.text()).toContain("baax");
    expect(output.text()).not.toContain("\x1b");
    for (const line of output.text().split("\n"))
      expect(displayWidth(line)).toBeLessThanOrEqual(28);
  });

  test("very narrow terminals retain readable table fields", () => {
    const output = capture(6);
    const ui = new TerminalUI({ output: output.stream, color: false });
    ui.table(["配置", "状态", "当前"], [["国服", "空闲", "课程"]]);
    for (const line of output.text().split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(6);
    expect(output.text()).toContain("配置:");
  });

  test("service text cannot escape success and result rendering", () => {
    const output = capture();
    const ui = new TerminalUI({ output: output.stream, color: false });
    ui.success("ready\x1b[2J\rhidden");
    ui.result("data\x1b]52;c;secret\x07");
    ui.table(["header"], [["row\x1b[6n"]]);
    expect(output.text()).not.toContain("\x1b");
    expect(output.text()).not.toContain("\r");
    expect(output.text()).not.toContain("secret");
  });

  test("JSON results and events remain parseable, with controls escaped", () => {
    const output = capture();
    const ui = new TerminalUI({ output: output.stream, json: true });
    ui.welcome({ version: "0.1.0", endpoint: "demo://local" });
    ui.result({ message: "safe\x1b[2J", value: 3 });
    ui.event({ type: "tool-result", name: "tasks", result: ["课程"] });
    const lines = output
      .text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { message: "safe\x1b[2J", value: 3 },
      { type: "tool-result", name: "tasks", result: ["课程"] },
    ]);
    expect(output.text()).not.toContain("\x1b");
  });

  test("text delta rendering stays on one line and ends before tools", () => {
    const output = capture();
    const ui = new TerminalUI({ output: output.stream, color: false });
    ui.event({ type: "text-delta", text: "正在" });
    ui.event({ type: "text-delta", text: "检查配置。" });
    ui.event({ type: "tool-start", name: "status", args: {} });
    expect(output.text()).toStartWith("正在检查配置。\n◌ status\n");
  });

  test("stream sanitizer strips CSI, OSC and other strings at every chunk boundary", () => {
    const attacks = [
      "before\x1b[2Jafter",
      "before\x1b]52;c;clipboard-secret\x07after",
      "before\x1b]8;;https://evil.invalid\x1b\\after",
      "before\x1bPterminal-payload\x1b\\after",
      "before\u009d52;c;c1-secret\u009cafter",
      "before\x1b(Bafter",
    ];
    for (const attack of attacks) {
      for (let split = 0; split <= attack.length; split++) {
        const sanitizer = new TerminalTextSanitizer();
        expect(
          sanitizer.write(attack.slice(0, split)) +
            sanitizer.write(attack.slice(split)) +
            sanitizer.flush()
        ).toBe("beforeafter");
      }
      const sanitizer = new TerminalTextSanitizer();
      expect([...attack].map((char) => sanitizer.write(char)).join("") + sanitizer.flush()).toBe(
        "beforeafter"
      );
    }
  });

  test("flush drops incomplete controls and resets the next response", () => {
    const sanitizer = new TerminalTextSanitizer();
    expect(sanitizer.write("safe\x1b]52;c;hidden")).toBe("safe");
    expect(sanitizer.flush()).toBe("");
    expect(sanitizer.write("新的回答")).toBe("新的回答");
    expect(sanitizer.write("\x1b[")).toBe("");
    expect(sanitizer.flush()).toBe("");
    expect(sanitizer.write("ready")).toBe("ready");
  });

  test("text delta rendering never leaks fragmented control payloads", () => {
    const output = capture();
    const ui = new TerminalUI({ output: output.stream, color: false });
    for (const text of ["回答", "\x1b", "]52;c;", "hidden", "\x1b", "\\", "完成", "\x1b["])
      ui.event({ type: "text-delta", text });
    ui.event({ type: "finish" });
    ui.event({ type: "text-delta", text: "下一轮" });
    ui.event({ type: "finish" });
    expect(output.text()).toBe("回答完成\n下一轮\n");
  });

  test("monitoring events show readable logs, connection changes and correlated results", () => {
    const output = capture(40);
    const ui = new TerminalUI({ output: output.stream, color: false });
    ui.event({ type: "connection", state: "connected", message: "本地服务" });
    ui.event({
      type: "live-log",
      entry: { scope: "config:main", level: "INFO", message: "日志\x1b]52;c;hidden\x07" },
    });
    ui.event({
      type: "run-status",
      profile: "主号",
      status: { running: true, current_task: "arena", run_id: "run-1" },
    });
    ui.event({
      type: "run-status",
      profile: "主号",
      status: { running: false, exit_code: 0, run_id: "run-1" },
    });
    ui.event({
      type: "run-status",
      profile: "副号",
      status: { running: false, exit_code: 1, run_id: "run-2" },
    });
    ui.event({ type: "connection", state: "closed" });
    ui.event({ type: "connection", state: "retrying", message: "恢复只读连接" });
    ui.event({ type: "connection", state: "restored" });
    expect(output.text()).toContain("服务已连接");
    expect(output.text()).toContain("config:main · INFO");
    expect(output.text()).toContain("主号 运行中");
    expect(output.text()).toContain("主号 本次运行已结束");
    expect(output.text()).toContain("副号 本次运行失败");
    expect(output.text()).toContain("服务连接已断开");
    expect(output.text()).toContain("正在重新连接服务");
    expect(output.text()).toContain("服务连接已恢复");
    expect(output.text()).not.toContain("hidden");
    expect(output.text()).not.toContain("\x1b");
    for (const line of output.text().split("\n"))
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
  });

  test("accepted automation jobs never imply completed game tasks", () => {
    const output = capture();
    const ui = new TerminalUI({ output: output.stream, color: false });
    ui.event({
      type: "tool-result",
      name: "scheduler_start",
      result: { accepted: true, completed: false },
    });
    expect(output.text()).toContain("已提交（尚未完成）");
    expect(output.text()).not.toContain("✓");
  });

  test("noninteractive spinners produce a single stable line and stop idempotently", () => {
    const output = capture();
    const ui = new TerminalUI({ output: output.stream, color: false });
    const stop = ui.spinner("读取配置");
    stop();
    stop();
    expect(output.text()).toBe("◇ 读取配置\n");
  });

  test("cancelled questions and approvals reject before opening an input reader", async () => {
    const output = capture();
    const ui = new TerminalUI({ output: output.stream, color: false });
    const signal = AbortSignal.abort(new Error("cancelled input"));
    await expect(ui.prompt("Question", signal)).rejects.toThrow("cancelled input");
    await expect(ui.secret("Key", signal)).rejects.toThrow("cancelled input");
    await expect(ui.confirm("Approve", signal)).rejects.toThrow("cancelled input");
    await expect(
      ui.select({ title: "Select", items: [{ value: "one", label: "One" }] }, signal)
    ).rejects.toThrow("cancelled input");
    expect(output.text()).toBe("");
  });

  test("empty selectors finish without opening a reader", async () => {
    const output = capture();
    const ui = new TerminalUI({ output: output.stream, color: false });
    expect(await ui.select({ title: "Empty", items: [] })).toBeUndefined();
    expect(output.text()).toBe("");
  });

  test.skipIf(process.platform === "win32" || typeof Bun.Terminal !== "function")(
    "PTY arrow selection and cancellation restore the reader",
    async () => {
      const selected = await ptyInput("result=await ui.select(options);", "选择配置档", "\x1b[B\r");
      expect(selected.check.result).toBe("second");
      const escaped = await ptyInput("result=await ui.select(options);", "选择配置档", "\x1b");
      expect(escaped.check.result).toBeNull();
      const interrupted = await ptyInput("result=await ui.select(options);", "选择配置档", "\x03");
      expect(interrupted.check.result).toBeNull();
    }
  );

  test.skipIf(process.platform === "win32" || typeof Bun.Terminal !== "function")(
    "PTY aborted selection restores raw mode and listeners",
    async () => {
      const { check } = await ptyInput(
        'setTimeout(()=>controller.abort(new Error("select-aborted")),100);try {result=await ui.select(options,controller.signal);}catch(e){error=e.message;}',
        "选择配置档"
      );
      expect(check.error).toBe("select-aborted");
    }
  );

  test.skipIf(process.platform === "win32" || typeof Bun.Terminal !== "function")(
    "PTY secrets never echo even when pasted as soon as the prompt appears",
    async () => {
      const submitted = await ptyInput(
        'matched=(await ui.secret("SECRET> "))==="private-token";',
        "SECRET> ",
        "private-token\r"
      );
      expect(submitted.check.matched).toBe(true);
      expect(submitted.output).not.toContain("private-token");
      const aborted = await ptyInput(
        'setTimeout(()=>controller.abort(new Error("secret-aborted")),100);try {await ui.secret("SECRET> ",controller.signal);}catch(e){error=e.message;}',
        "SECRET> ",
        "private-token"
      );
      expect(aborted.check.error).toBe("secret-aborted");
      expect(aborted.output).not.toContain("private-token");
    }
  );
});
