import { createInterface, emitKeypressEvents, type Key } from "node:readline";
import { Writable } from "node:stream";

const RESET = "\x1b[0m";
const PALETTE = {
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  amber: "\x1b[33m",
};
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Strip terminal commands even when streamed chunks split control sequences. */
export class TerminalTextSanitizer {
  private state: "text" | "escape" | "intermediate" | "csi" | "osc" | "string" | "string-escape" =
    "text";
  private stringState: "osc" | "string" = "string";

  write(value: unknown): string {
    let result = "";
    for (const char of String(value ?? "")) {
      const code = char.codePointAt(0)!;
      if (this.state === "osc" || this.state === "string") {
        if (code === 0x9c || (this.state === "osc" && code === 7)) this.state = "text";
        else if (code === 0x1b) {
          this.stringState = this.state;
          this.state = "string-escape";
        }
        continue;
      }
      if (this.state === "string-escape") {
        if (char === "\\" || code === 0x9c || (this.stringState === "osc" && code === 7))
          this.state = "text";
        else if (code !== 0x1b) this.state = this.stringState;
        continue;
      }
      if (code === 0x1b) {
        this.state = "escape";
        continue;
      }
      if (code === 0x9b) {
        this.state = "csi";
        continue;
      }
      if (code === 0x9d) {
        this.state = "osc";
        continue;
      }
      if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) {
        this.state = "string";
        continue;
      }
      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        continue;
      }
      if (this.state === "escape") {
        if (char === "[") this.state = "csi";
        else if (char === "]") this.state = "osc";
        else if (["P", "X", "^", "_"].includes(char)) this.state = "string";
        else if (code >= 0x20 && code <= 0x2f) this.state = "intermediate";
        else this.state = "text";
        continue;
      }
      if (this.state === "intermediate") {
        if (code >= 0x30 && code <= 0x7e) this.state = "text";
        continue;
      }
      if ((code < 0x20 && code !== 10) || (code >= 0x7f && code <= 0x9f)) continue;
      if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) continue;
      result += char;
    }
    return result;
  }

  /** End a response and discard any unterminated terminal control sequence. */
  flush(): string {
    this.state = "text";
    return "";
  }
}

/** Keep data from services and command packs from issuing terminal commands. */
export function terminalText(value: unknown): string {
  const sanitizer = new TerminalTextSanitizer();
  return sanitizer.write(value) + sanitizer.flush();
}

function graphemeWidth(value: string): number {
  if (/^[\p{Mark}\p{Default_Ignorable_Code_Point}]*$/u.test(value)) return 0;
  if (/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value) || value.includes("\u20e3"))
    return 2;
  const code = value.codePointAt(0) ?? 0;
  return code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1b000 && code <= 0x1b2ff) ||
      (code >= 0x20000 && code <= 0x3fffd))
    ? 2
    : 1;
}

export function displayWidth(value: string): number {
  return [...segmenter.segment(terminalText(value))].reduce(
    (sum, entry) => sum + (entry.segment === "\n" ? 0 : graphemeWidth(entry.segment)),
    0
  );
}

export function truncateText(value: string, width: number): string {
  const text = terminalText(value).replace(/\n/g, " ");
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  let result = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = graphemeWidth(segment);
    if (used + size > width - 1) break;
    result += segment;
    used += size;
  }
  return `${result}…`;
}

function wrapText(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const original of terminalText(value).split("\n")) {
    let line = "";
    let used = 0;
    for (const { segment } of segmenter.segment(original)) {
      const size = graphemeWidth(segment);
      if (size > width) {
        if (line) lines.push(line);
        lines.push("?");
        line = "";
        used = 0;
        continue;
      }
      if (used + size > width && line) {
        lines.push(line);
        line = "";
        used = 0;
      }
      line += segment;
      used += size;
    }
    lines.push(line);
  }
  return lines;
}

function serialize(data: unknown, pretty = false): string {
  return (
    JSON.stringify(
      data,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      pretty ? 2 : undefined
    ) ?? "null"
  );
}

function cell(data: unknown): string {
  return terminalText(
    data === undefined || data === null ? "—" : typeof data === "object" ? serialize(data) : data
  ).replace(/\n/g, " ↵ ");
}

export interface WelcomeOptions {
  version: string;
  endpoint: string;
  profile?: string;
  mode?: string;
  connected?: boolean;
}

export interface SelectOptions {
  title: string;
  items: { value: string; label: string; description?: string }[];
  initial?: string;
}

export class TerminalUI {
  readonly json: boolean;
  private readonly color: boolean;
  private readonly output: NodeJS.WriteStream;
  private activeSpinner?: () => void;
  private streaming = false;
  private readonly textSanitizer = new TerminalTextSanitizer();

  constructor(options: { json?: boolean; color?: boolean; output?: NodeJS.WriteStream } = {}) {
    this.json = options.json ?? false;
    this.output = options.output ?? process.stdout;
    this.color =
      options.color ??
      (Boolean(this.output.isTTY) &&
        process.env.NO_COLOR === undefined &&
        process.env.TERM !== "dumb");
  }

  private get messages(): NodeJS.WriteStream {
    return this.json ? process.stderr : this.output;
  }
  private get width(): number {
    return Math.max(1, Math.min(100, this.messages.columns || this.output.columns || 80));
  }
  private paint(text: string, color: keyof typeof PALETTE): string {
    return this.color ? `${PALETTE[color]}${text}${RESET}` : text;
  }
  private line(text = "", color?: keyof typeof PALETTE): void {
    this.activeSpinner?.();
    this.finishText();
    for (const line of wrapText(text, this.width))
      this.messages.write(`${color ? this.paint(line, color) : line}\n`);
  }
  private finishText(): void {
    this.textSanitizer.flush();
    if (this.streaming) {
      this.messages.write("\n");
      this.streaming = false;
    }
  }

  welcome(options: WelcomeOptions): void {
    if (this.json) return;
    const title = `BAAS CLI v${terminalText(options.version)}`;
    this.line();
    if (this.width >= 58) {
      const mark = ["   ◇   ", " ╭─┴─╮ ", " │• •│ ", " ╰─⌄─╯ "];
      const copy = [
        title,
        "Sensei's automation terminal",
        `模式 ${options.mode ?? "交互终端"}`,
        "为你的每一天，安排得井井有条。",
      ];
      mark.forEach((row, index) =>
        this.line(`${row}  ${copy[index]}`, index === 0 ? "cyan" : index === 1 ? "dim" : undefined)
      );
    } else {
      this.line(`◇ ${title}`, "cyan");
      this.line("Sensei's terminal", "dim");
    }
    this.line();
    this.line(`服务 ${options.endpoint}`, "dim");
    this.line(
      `配置 ${options.profile ?? "尚未选择"} · ${options.connected === true ? "已连接" : options.connected === false ? "待连接" : "等待检查"}`,
      "dim"
    );
    this.divider();
    this.line("输入 /help 浏览指令，或 /tasks 选择 BAAS 任务。", "dim");
    this.line();
  }

  info(message: string): void {
    this.line(`◇ ${message}`, "cyan");
  }
  success(message: string): void {
    this.line(`✓ ${message}`, "green");
  }
  error(message: string): void {
    this.line(`✗ ${message}`, "red");
  }

  result(data: unknown): void {
    this.activeSpinner?.();
    if (this.json) this.output.write(`${serialize(data)}\n`);
    else if (typeof data === "string") this.line(data);
    else this.line(serialize(data, true));
  }

  table(headers: string[], rows: unknown[][]): void {
    if (this.json) {
      this.result(
        rows.map((row) =>
          Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null]))
        )
      );
      return;
    }
    if (!headers.length) {
      if (rows.length) this.result(rows);
      return;
    }
    if (!rows.length) {
      this.line("暂无数据", "dim");
      return;
    }
    const safeHeaders = headers.map((header) => cell(header));
    const values = rows.map((row) => headers.map((_header, index) => cell(row[index])));
    const widths = safeHeaders.map((header, index) =>
      Math.max(
        2,
        Math.min(48, displayWidth(header), this.width),
        ...values.map((row) => Math.min(48, displayWidth(row[index])))
      )
    );
    const budget = this.width - (headers.length - 1) * 3;
    if (budget < headers.length * 2) {
      values.forEach((row, index) => {
        if (index) this.line();
        safeHeaders.forEach((header, col) => this.line(`${header}: ${row[col]}`));
      });
      return;
    }
    while (widths.reduce((sum, size) => sum + size, 0) > budget) {
      const largest = widths.indexOf(Math.max(...widths));
      widths[largest] -= 1;
    }
    const render = (row: string[]) =>
      row
        .map((value, index) => {
          const text = truncateText(value, widths[index]);
          return text + " ".repeat(Math.max(0, widths[index] - displayWidth(text)));
        })
        .join("   ")
        .trimEnd();
    this.line(render(safeHeaders), "cyan");
    this.line(widths.map((width) => "─".repeat(width)).join("   "), "dim");
    values.forEach((row) => this.line(render(row)));
  }

  event(event: { type: string; [key: string]: unknown }): void {
    if (this.json) {
      this.result(event);
      return;
    }
    switch (event.type) {
      case "text-delta": {
        this.activeSpinner?.();
        const text = this.textSanitizer.write(event.text);
        this.messages.write(text);
        if (text) this.streaming = !text.endsWith("\n");
        break;
      }
      case "tool-start":
        this.line(`◌ ${event.name ?? "工具"}${event.mutating ? " · 修改操作" : ""}`, "cyan");
        break;
      case "approval-required":
        this.line(`? ${event.name ?? "操作"} 等待你的确认`, "amber");
        break;
      case "tool-result": {
        const result =
          event.result && typeof event.result === "object"
            ? (event.result as Record<string, unknown>)
            : undefined;
        if (result?.error) this.error(`${event.name ?? "工具"}: ${result.error}`);
        else if (result?.accepted && result.completed === false)
          this.info(`${event.name ?? "工具"} 已提交（尚未完成）`);
        else this.info(`${event.name ?? "工具"} 返回`);
        this.result(event.result);
        break;
      }
      case "tool-denied":
        this.line(`○ 已取消 ${event.name ?? "操作"}`, "dim");
        break;
      case "tool-error":
        this.error(`${event.name ?? "工具"}: ${event.error ?? "执行失败"}`);
        break;
      case "live-log": {
        const entry =
          event.entry && typeof event.entry === "object"
            ? (event.entry as Record<string, unknown>)
            : {};
        const parts = [entry.time, entry.scope, entry.level].filter(
          (value) => value !== undefined && value !== null
        );
        this.line(`${parts.length ? `[${parts.join(" · ")}] ` : ""}${entry.message ?? ""}`);
        break;
      }
      case "run-status": {
        const status =
          event.status && typeof event.status === "object"
            ? (event.status as Record<string, unknown>)
            : {};
        const profile = String(event.profile ?? status.config_id ?? "当前配置档");
        const task = status.current_task ? ` · ${status.current_task}` : "";
        const run = status.run_id ? ` · ${status.run_id}` : "";
        if (status.running === true) this.info(`${profile} 运行中${task}${run}`);
        else if (status.running === false && status.exit_code === 0)
          this.success(`${profile} 本次运行已结束${run}`);
        else if (
          status.running === false &&
          typeof status.exit_code === "number" &&
          status.exit_code !== 0
        )
          this.error(`${profile} 本次运行失败（退出码 ${status.exit_code}）${run}`);
        else
          this.line(
            `○ ${profile} ${status.running === false ? "空闲" : "状态更新"}${task}${run}`,
            "dim"
          );
        break;
      }
      case "connection": {
        const state = String(event.state ?? "unknown");
        const message = event.message ? ` · ${event.message}` : "";
        if (state === "connected" || state === "restored")
          this.info(`${state === "restored" ? "服务连接已恢复" : "服务已连接"}${message}`);
        else if (["error", "failed"].includes(state)) this.error(`服务连接失败${message}`);
        else
          this.line(
            `○ ${state === "connecting" ? "正在连接服务" : state === "retrying" ? "正在重新连接服务" : ["disconnected", "closed", "lost"].includes(state) ? "服务连接已断开" : state}${message}`,
            "dim"
          );
        break;
      }
      case "finish":
        this.finishText();
        break;
      default:
        this.info(String(event.message ?? event.text ?? event.type));
    }
  }

  divider(title?: string): void {
    const label = title ? ` ${truncateText(title, Math.max(1, this.width - 4))} ` : "";
    const remainder = Math.max(0, this.width - displayWidth(label));
    this.line(`${label}${"─".repeat(remainder)}`, "dim");
  }

  spinner(label: string): () => void {
    this.activeSpinner?.();
    this.finishText();
    if (this.json || !this.messages.isTTY || process.env.TERM === "dumb") {
      this.info(label);
      return () => {};
    }
    const frames = ["◌", "◔", "◑", "◕"];
    let index = 0;
    let stopped = false;
    const render = () =>
      this.messages.write(
        `\r\x1b[2K${this.paint(truncateText(`${frames[index++ % frames.length]} ${label}`, this.width), "cyan")}`
      );
    render();
    const timer = setInterval(render, 110);
    timer.unref();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      this.messages.write("\r\x1b[2K");
      if (this.activeSpinner === stop) this.activeSpinner = undefined;
    };
    this.activeSpinner = stop;
    return stop;
  }

  /** The REPL owner must pause its reader before using a temporary question. */
  prompt(question: string, signal?: AbortSignal): Promise<string> {
    return this.ask(question, false, signal);
  }
  secret(question: string, signal?: AbortSignal): Promise<string> {
    return this.ask(question, true, signal);
  }

  /** A temporary reader; the caller must release its prompt before opening it. */
  async select(options: SelectOptions, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    if (!options.items.length) return undefined;
    if (this.json || !process.stdin.isTTY)
      throw new Error("需要交互终端选择；请显式提供对应参数。");
    this.activeSpinner?.();
    this.finishText();
    const input = process.stdin;
    const wasPaused = input.isPaused();
    const wasRaw = input.isRaw;
    const muted = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const reader = createInterface({ input, output: muted, terminal: true, escapeCodeTimeout: 50 });
    emitKeypressEvents(input, reader);
    input.setRawMode(true);
    input.resume();
    let selected = Math.max(
      0,
      options.items.findIndex((item) => item.value === options.initial)
    );
    let renderedLines = 0;
    let chosen: string | undefined;
    let onKey: ((_text: string, key: Key) => void) | undefined;
    let onAbort: (() => void) | undefined;
    const clear = () => {
      if (!renderedLines) return;
      this.messages.write(`\x1b[${renderedLines}A\r`);
      for (let index = 0; index < renderedLines; index++) this.messages.write("\x1b[2K\n");
      this.messages.write(`\x1b[${renderedLines}A\r`);
      renderedLines = 0;
    };
    const render = () => {
      clear();
      const count = Math.min(options.items.length, Math.max(1, (this.messages.rows || 24) - 6));
      const first = Math.max(
        0,
        Math.min(selected - Math.floor(count / 2), options.items.length - count)
      );
      const lines = [this.paint(truncateText(options.title, this.width), "cyan")];
      for (let index = first; index < first + count; index++) {
        const text = truncateText(
          `${index === selected ? "›" : " "} ${options.items[index].label}`,
          this.width
        );
        lines.push(index === selected ? this.paint(text, "cyan") : text);
      }
      const description = options.items[selected].description;
      if (description) lines.push(this.paint(truncateText(description, this.width), "dim"));
      lines.push(this.paint(truncateText("↑↓ 选择 · Enter 确定 · Esc 返回", this.width), "dim"));
      this.messages.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };
    this.messages.write("\x1b[?25l");
    try {
      chosen = await new Promise<string | undefined>((resolve, reject) => {
        let settled = false;
        const finish = (value?: string) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        onKey = (_text, key) => {
          if (!key || settled) return;
          if (key.name === "escape" || (key.ctrl && key.name === "c")) finish();
          else if (key.name === "return" || key.name === "enter")
            finish(options.items[selected].value);
          else if (
            key.name === "up" ||
            key.name === "down" ||
            key.name === "home" ||
            key.name === "end"
          ) {
            selected =
              key.name === "home"
                ? 0
                : key.name === "end"
                  ? options.items.length - 1
                  : (selected + (key.name === "up" ? -1 : 1) + options.items.length) %
                    options.items.length;
            render();
          }
        };
        onAbort = () => {
          if (!settled) {
            settled = true;
            reject(signal?.reason ?? new DOMException("选择已取消", "AbortError"));
          }
          reader.close();
        };
        input.on("keypress", onKey);
        reader.once("close", () => finish());
        reader.once("SIGINT", () => finish());
        signal?.addEventListener("abort", onAbort, { once: true });
        this.messages.on("resize", render);
        if (signal?.aborted) onAbort();
        else render();
      });
    } finally {
      if (onKey) input.off("keypress", onKey);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      this.messages.off("resize", render);
      reader.close();
      if (input.isTTY && input.isRaw !== wasRaw) input.setRawMode(Boolean(wasRaw));
      if (wasPaused) input.pause();
      clear();
      this.messages.write("\x1b[?25h");
      muted.end();
    }
    if (chosen !== undefined) {
      const label = options.items.find((item) => item.value === chosen)?.label ?? chosen;
      this.info(`${options.title} · ${label}`);
    }
    return chosen;
  }

  async confirm(message: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (this.json || !process.stdin.isTTY) return false;
    const answer = await this.prompt(`${message} [y/N] `, signal);
    signal?.throwIfAborted();
    return /^(y|yes|是|确认)$/i.test(answer.trim());
  }

  private async ask(question: string, hidden: boolean, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.json || !process.stdin.isTTY)
      throw new Error("需要交互终端输入；请显式提供对应参数。");
    this.activeSpinner?.();
    this.finishText();
    const input = process.stdin;
    const wasPaused = input.isPaused();
    const wasRaw = input.isRaw;
    const muted = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const reader = createInterface({
      input,
      output: hidden ? muted : this.messages,
      terminal: true,
    });
    // Disable terminal echo before announcing the secret prompt: input can
    // arrive immediately after its text appears, including from pasted text.
    if (hidden) {
      input.setRawMode(true);
      this.messages.write(terminalText(question));
    }
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (answer = "") => {
          if (!settled) {
            settled = true;
            resolve(answer);
          }
        };
        reader.once("close", () => finish());
        reader.once("SIGINT", () => {
          finish();
          reader.close();
        });
        onAbort = () => {
          if (!settled) {
            settled = true;
            reject(signal?.reason ?? new DOMException("输入已取消", "AbortError"));
          }
          reader.close();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        reader.question(hidden ? "" : terminalText(question), (answer) => finish(answer));
      });
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      reader.close();
      if (input.isTTY && input.isRaw !== wasRaw) input.setRawMode(Boolean(wasRaw));
      if (wasPaused) input.pause();
      if (hidden) {
        this.messages.write("\n");
        muted.end();
      }
    }
  }
}
