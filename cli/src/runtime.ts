import { BaasClient } from "@baas/client";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { abortable } from "./monitor";
import { createRedactor } from "./redaction";
import { TerminalTextSanitizer, terminalText } from "./ui";

export type RuntimeChannel = "stable" | "dev";
export interface RuntimeState {
  installed: boolean;
  managed: boolean;
  root: string;
  backendPath: string;
  pythonPath: string;
  cppPath: string;
  channel: RuntimeChannel;
  missing: string[];
}
export interface RuntimeEvent {
  type: "progress";
  stage: string;
  message: string;
}
export interface RuntimeManagerOptions {
  directory: string;
  helperPath?: string;
}
interface LaunchSpec {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
interface RuntimeMetadata {
  schemaVersion: 1;
  root: string;
  channel: RuntimeChannel;
}
interface OwnedBackend {
  child: ChildProcess;
  pipe: string;
  socketDirectory?: string;
  stop: () => Promise<void>;
}

const MAX_LINE = 65_536;
const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_STDERR = 16_384;
const INSPECT_TIMEOUT = 15_000;
const INSTALL_TIMEOUT = 60 * 60 * 1000;
const START_TIMEOUT = 45_000;
const CHANNELS = new Set(["stable", "dev"]);

export class RuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown, maximum = 32_768): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(path);
  }
}
function cancelled(): DOMException {
  return new DOMException("本地环境操作已取消", "AbortError");
}

/** Terminate only the process group we created; never discover or kill unrelated Python jobs. */
async function stopTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    await new Promise<void>((done) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        killer.kill();
        child.kill();
        done();
      }, 2000);
      killer.once("error", () => {
        clearTimeout(timer);
        child.kill();
        done();
      });
      killer.once("close", () => {
        clearTimeout(timer);
        done();
      });
    });
    return;
  }
  // PTYs may create a new session/process group. Snapshot descendants before
  // signalling the helper so those processes cannot escape by becoming orphans.
  const descendants = await new Promise<number[]>((done) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid="],
      { timeout: 1500, maxBuffer: 2 * 1024 * 1024 },
      (error, output) => {
        if (error) return done([]);
        const parents = new Map<number, number[]>();
        for (const line of output.split("\n")) {
          const fields = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
          if (!fields) continue;
          const processId = Number(fields[1]),
            parentId = Number(fields[2]);
          if (processId <= 1 || processId === process.pid) continue;
          parents.set(parentId, [...(parents.get(parentId) || []), processId]);
        }
        const result: number[] = [];
        const pending = [...(parents.get(pid) || [])];
        const seen = new Set<number>();
        while (pending.length && result.length < 10_000) {
          const current = pending.pop()!;
          if (seen.has(current)) continue;
          seen.add(current);
          result.push(current);
          pending.push(...(parents.get(current) || []));
        }
        done(result.reverse());
      }
    );
  });
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
    }
  };
  killGroup("SIGTERM");
  // A helper can have exited while a compiler/downloader remains in its process group.
  await new Promise((done) => setTimeout(done, 200));
  for (const descendant of descendants) {
    try {
      process.kill(descendant, "SIGKILL");
    } catch {
      /* The helper may already have reaped the descendant. */
    }
  }
  killGroup("SIGKILL");
}

/** Local BAAS installation and process ownership, independent of the desktop application's runtime. */
export class RuntimeManager {
  private readonly directory: string;
  private readonly helperPath?: string;
  private readonly redactor = createRedactor([process.env.BAAS_KEY]);
  private active?: AbortController;
  private backend?: OwnedBackend;
  private closed = false;

  constructor(options: RuntimeManagerOptions) {
    if (!string(options.directory)) throw new RuntimeError("runtime_config", "CLI 环境目录无效");
    this.directory = resolve(options.directory);
    this.helperPath = options.helperPath || process.env.BAAS_RUNTIME_HELPER;
  }

  async getConfigRoot(): Promise<string> {
    return (await this.metadata())?.root || join(this.directory, "runtime");
  }

  async inspect(): Promise<RuntimeState> {
    return this.operation(undefined, INSPECT_TIMEOUT, async (signal) =>
      this.inspectRoot(await this.getConfigRoot(), signal)
    );
  }

  async install(
    options: { root?: string; channel?: RuntimeChannel } = {},
    onEvent?: (event: RuntimeEvent) => void,
    signal?: AbortSignal
  ): Promise<RuntimeState> {
    return this.operation(signal, INSTALL_TIMEOUT, async (operationSignal) => {
      if (this.backend) throw new RuntimeError("runtime_busy", "请先关闭当前本地后端再更新环境");
      const previous = await this.metadata();
      const root = resolve(options.root || previous?.root || join(this.directory, "runtime"));
      const channel = options.channel || previous?.channel || "dev";
      if (!string(root) || !CHANNELS.has(channel))
        throw new RuntimeError("runtime_config", "安装目录或更新通道无效");
      const data = await this.helper(
        ["install", "--root", root, "--channel", channel],
        operationSignal,
        onEvent
      );
      const installed = await this.state(data, root);
      operationSignal.throwIfAborted();
      if (!installed.installed || !installed.managed || installed.missing.length)
        throw new RuntimeError(
          "install_incomplete",
          `本地环境尚未安装完整：${installed.missing.join("、") || "安装校验未通过"}`
        );
      // The helper's result is not a substitute for inspecting the published installation.
      const verified = await this.inspectRoot(installed.root, operationSignal);
      if (!verified.installed || !verified.managed || verified.missing.length)
        throw new RuntimeError("install_incomplete", "安装后的环境校验未通过，请重试安装");
      operationSignal.throwIfAborted();
      await this.saveMetadata({ schemaVersion: 1, root: verified.root, channel: verified.channel });
      return verified;
    });
  }

  async start(
    onEvent?: (event: RuntimeEvent) => void,
    signal?: AbortSignal
  ): Promise<{ pipe: string }> {
    return this.operation(signal, START_TIMEOUT, async (operationSignal) => {
      if (
        this.backend &&
        this.backend.child.exitCode === null &&
        this.backend.child.signalCode === null
      )
        return { pipe: this.backend.pipe };
      const state = await this.inspectRoot(await this.getConfigRoot(), operationSignal);
      if (!state.installed || !state.managed || state.missing.length)
        throw new RuntimeError("runtime_missing", "本地 BAAS 环境尚未安装完整，请先执行 setup");
      const socketDirectory =
        process.platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), "baas-cli-"));
      if (socketDirectory) await chmod(socketDirectory, 0o700);
      const pipe =
        process.platform === "win32"
          ? `\\\\.\\pipe\\baas-cli-${randomUUID()}`
          : join(socketDirectory!, "service.sock");
      if (process.platform !== "win32" && Buffer.byteLength(pipe) > 100) {
        await rm(socketDirectory!, { recursive: true, force: true });
        throw new RuntimeError("runtime_pipe", "系统临时目录过长，无法创建本地服务套接字");
      }
      let owned: OwnedBackend | undefined;
      try {
        const spec = this.launchSpec(
          await this.helper(
            ["launch-spec", "--root", state.root, "--pipe", pipe],
            operationSignal,
            onEvent
          ),
          state,
          pipe
        );
        operationSignal.throwIfAborted();
        this.emit(onEvent, "backend", "正在启动私有 BAAS 后端并等待连接握手");
        const child = spawn(spec.program, spec.args, {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stopped: Promise<void> | undefined;
        owned = {
          child,
          pipe,
          socketDirectory,
          stop: () =>
            (stopped ||= stopTree(child).finally(async () => {
              if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
            })),
        };
        this.backend = owned;
        const owner = owned;
        let exited: Error | undefined;
        child.once("error", (error) => {
          exited = error;
        });
        child.once("exit", (code, terminationSignal) => {
          exited = new RuntimeError(
            "backend_exit",
            `本地后端已退出（${terminationSignal || code}）`
          );
          if (this.backend === owner) this.backend = undefined;
          void owner.stop().catch(() => {});
        });
        this.drainBackend(child, onEvent);
        for (;;) {
          operationSignal.throwIfAborted();
          if (exited) throw exited;
          const client = new BaasClient({ pipe, timeoutMs: 600 });
          try {
            await abortable(client.connect(), operationSignal);
            if (exited) throw exited;
            operationSignal.throwIfAborted();
            this.emit(onEvent, "ready", "本地 BAAS 后端已就绪");
            return { pipe };
          } catch {
            operationSignal.throwIfAborted();
            if (exited) throw exited;
          } finally {
            client.close();
          }
          await abortable(new Promise((done) => setTimeout(done, 100)), operationSignal);
        }
      } catch (error) {
        if (owned) {
          if (this.backend === owned) this.backend = undefined;
          await owned.stop();
        } else if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
        throw error;
      }
    });
  }

  /** Stop this manager's own backend. External services and other CLI processes are never targeted. */
  close(): void {
    this.closed = true;
    this.active?.abort(cancelled());
    const backend = this.backend;
    this.backend = undefined;
    if (backend) void backend.stop().catch(() => {});
  }

  private async operation<T>(
    signal: AbortSignal | undefined,
    timeout: number,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.closed) throw new RuntimeError("runtime_closed", "本地环境管理器已关闭");
    if (this.active) throw new RuntimeError("runtime_busy", "已有本地环境操作正在进行");
    signal?.throwIfAborted();
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(
      () =>
        controller.abort(
          new RuntimeError("runtime_timeout", "本地环境操作等待超时，请重试或查看日志")
        ),
      timeout
    );
    this.active = controller;
    try {
      return await run(combined);
    } finally {
      clearTimeout(timer);
      if (this.active === controller) this.active = undefined;
    }
  }

  private async metadata(): Promise<RuntimeMetadata | undefined> {
    const file = join(this.directory, "runtime.json");
    try {
      if ((await stat(file)).size > 65_536) throw new Error("环境记录过大");
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      if (
        !record(value) ||
        value.schemaVersion !== 1 ||
        !string(value.root) ||
        !isAbsolute(value.root) ||
        !CHANNELS.has(String(value.channel))
      )
        throw new Error("环境记录格式无效");
      return { schemaVersion: 1, root: value.root, channel: value.channel as RuntimeChannel };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new RuntimeError(
        "runtime_metadata",
        `无法读取本地环境记录：${this.safe((error as Error).message)}`
      );
    }
  }

  private async saveMetadata(metadata: RuntimeMetadata): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, "runtime.json");
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async inspectRoot(root: string, signal: AbortSignal): Promise<RuntimeState> {
    return this.state(await this.helper(["inspect", "--root", root], signal), root);
  }

  private async state(value: unknown, root: string): Promise<RuntimeState> {
    if (
      !record(value) ||
      typeof value.installed !== "boolean" ||
      typeof value.managed !== "boolean" ||
      !string(value.root) ||
      !isAbsolute(value.root) ||
      !CHANNELS.has(String(value.channel)) ||
      !Array.isArray(value.missing) ||
      value.missing.length > 100 ||
      !value.missing.every((item) => string(item, 1024))
    )
      throw new RuntimeError("runtime_protocol", "安装组件返回的环境信息无效");
    for (const key of ["backendPath", "pythonPath", "cppPath"])
      if (!string(value[key]) || !isAbsolute(value[key] as string))
        throw new RuntimeError("runtime_protocol", "安装组件返回的文件路径无效");
    if ((await canonical(value.root)) !== (await canonical(root)))
      throw new RuntimeError("runtime_protocol", "安装组件返回了其他环境目录");
    return {
      installed: value.installed,
      managed: value.managed,
      root: value.root,
      backendPath: value.backendPath as string,
      pythonPath: value.pythonPath as string,
      cppPath: value.cppPath as string,
      channel: value.channel as RuntimeChannel,
      missing: [...value.missing] as string[],
    };
  }

  private launchSpec(value: unknown, state: RuntimeState, pipe: string): LaunchSpec {
    if (
      !record(value) ||
      value.program !== state.pythonPath ||
      value.cwd !== state.root ||
      !Array.isArray(value.args) ||
      !value.args.length ||
      value.args.length > 128 ||
      !value.args.every(
        (argument) =>
          typeof argument === "string" && argument.length <= 32_768 && !argument.includes("\0")
      ) ||
      value.args[0] !== state.backendPath ||
      !record(value.env) ||
      Object.keys(value.env).length > 128
    )
      throw new RuntimeError("runtime_protocol", "安装组件返回的启动参数无效");
    if (
      value.args.filter((argument) => argument === "--pipe-name").length !== 1 ||
      value.args[value.args.indexOf("--pipe-name") + 1] !== pipe
    )
      throw new RuntimeError("runtime_protocol", "安装组件未绑定本次独立的后端连接");
    for (const [key, item] of Object.entries(value.env))
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
        typeof item !== "string" ||
        item.length > 32_768 ||
        item.includes("\0")
      )
        throw new RuntimeError("runtime_protocol", "安装组件返回的进程环境无效");
    return {
      program: value.program as string,
      cwd: value.cwd as string,
      args: value.args as string[],
      env: value.env as Record<string, string>,
    };
  }

  private async executable(): Promise<string> {
    const filename = process.platform === "win32" ? "baas-cli-runtime.exe" : "baas-cli-runtime";
    const candidates = this.helperPath
      ? [resolve(this.helperPath)]
      : [
          join(import.meta.dir, "../runtime", filename),
          join(dirname(process.execPath), "runtime", filename),
          join(import.meta.dir, "../../target/debug", filename),
          join(import.meta.dir, "../../target/release", filename),
        ];
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        /* Try only bundled or previously built helpers, never invoke a build tool. */
      }
    }
    throw new RuntimeError(
      "helper_missing",
      "缺少 BAAS 本地安装组件。请安装包含 runtime/baas-cli-runtime 的完整 CLI 发布包，或设置 BAAS_RUNTIME_HELPER 指向已构建的组件。"
    );
  }

  private async helper(
    args: string[],
    signal: AbortSignal,
    onEvent?: (event: RuntimeEvent) => void
  ): Promise<unknown> {
    signal.throwIfAborted();
    const executable = await this.executable();
    signal.throwIfAborted();
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let buffer = "",
      stderr = "",
      total = 0;
    const stdoutDecoder = new StringDecoder("utf8");
    const diagnostics = this.diagnosticLines((line) => {
      stderr = (stderr + line + "\n").slice(-MAX_STDERR);
      this.emit(onEvent, "installer", line);
    });
    let result: unknown,
      hasResult = false,
      failure: Error | undefined;
    let rejectInterrupted!: (error: unknown) => void;
    const interrupted = new Promise<never>((_done, reject) => {
      rejectInterrupted = reject;
    });
    const fail = (error: Error) => {
      if (!failure) {
        failure = error;
        rejectInterrupted(error);
      }
    };
    const line = (source: string) => {
      if (!source.trim()) return;
      try {
        const value: unknown = JSON.parse(source);
        if (!record(value) || !string(value.type, 20))
          throw new Error("响应必须是带 type 的 JSON 对象");
        if (
          value.type === "progress" &&
          string(value.stage, 128) &&
          typeof value.message === "string" &&
          value.message.length <= MAX_LINE
        )
          this.emit(onEvent, value.stage, value.message);
        else if (value.type === "result" && !hasResult) {
          result = value.data;
          hasResult = true;
        } else if (
          value.type === "error" &&
          string(value.code, 128) &&
          string(value.message, MAX_LINE)
        )
          fail(new RuntimeError(value.code, this.safe(value.message)));
        else throw new Error("响应类型、字段或终止消息无效");
      } catch (error) {
        fail(
          error instanceof RuntimeError
            ? error
            : new RuntimeError(
                "runtime_protocol",
                `安装组件响应无效：${this.safe((error as Error).message)}`
              )
        );
      }
    };
    const readStdout = (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_OUTPUT)
        return fail(new RuntimeError("runtime_output", "安装组件输出超过限制"));
      buffer += stdoutDecoder.write(chunk);
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const entry = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(entry) > MAX_LINE)
          return fail(new RuntimeError("runtime_output", "安装组件单行输出超过限制"));
        line(entry);
        if (failure) return;
      }
      if (Buffer.byteLength(buffer) > MAX_LINE)
        fail(new RuntimeError("runtime_output", "安装组件单行输出超过限制"));
    };
    child.stdout!.on("data", readStdout);
    child.stderr!.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_OUTPUT)
        return fail(new RuntimeError("runtime_output", "安装组件输出超过限制"));
      diagnostics.push(chunk);
    });
    const completed = new Promise<void>((done) => {
      child.once("error", (error) =>
        fail(new RuntimeError("helper_failed", this.safe(error.message)))
      );
      child.once("close", (code, terminationSignal) => {
        buffer += stdoutDecoder.end();
        diagnostics.end();
        if (buffer.trim()) line(buffer);
        if (failure) return done();
        if (code !== 0)
          fail(
            new RuntimeError(
              "helper_failed",
              `安装组件退出（${terminationSignal || code}）${stderr ? `：${this.safe(stderr)}` : ""}`
            )
          );
        else if (!hasResult) fail(new RuntimeError("runtime_protocol", "安装组件未返回完成结果"));
        done();
      });
    });
    let successful = false;
    try {
      await abortable(Promise.race([completed, interrupted]), signal);
      signal.throwIfAborted();
      if (failure) throw failure;
      successful = true;
      return result;
    } finally {
      if (!successful) await stopTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }

  private drainBackend(child: ChildProcess, onEvent?: (event: RuntimeEvent) => void) {
    let window = Date.now(),
      emitted = 0;
    for (const stream of [child.stdout, child.stderr]) {
      const diagnostics = this.diagnosticLines((line) => {
        if (Date.now() - window >= 1000) {
          window = Date.now();
          emitted = 0;
        }
        if (emitted++ < 20) this.emit(onEvent, "backend", line);
      });
      stream?.on("data", (chunk: Buffer) => diagnostics.push(chunk));
      stream?.once("end", () => diagnostics.end());
    }
  }

  /** Keep diagnostic lines together so UTF-8, terminal escapes and credentials cannot leak across chunks. */
  private diagnosticLines(consume: (line: string) => void) {
    const decoder = new StringDecoder("utf8");
    const sanitizer = new TerminalTextSanitizer();
    let buffer = "",
      discarding = false;
    const append = (text: string) => {
      for (const character of sanitizer.write(text)) {
        if (character === "\n") {
          if (!discarding && buffer) consume(this.redactor.text(buffer));
          buffer = "";
          discarding = false;
        } else if (!discarding) {
          buffer += character;
          if (buffer.length > MAX_LINE) {
            buffer = "";
            discarding = true;
            consume("单行进程输出过长，已省略。");
          }
        }
      }
    };
    return {
      push: (chunk: Buffer) => append(decoder.write(chunk)),
      end: () => {
        append(decoder.end());
        if (!discarding && buffer) consume(this.redactor.text(buffer));
        buffer = "";
        sanitizer.flush();
      },
    };
  }

  private safe(value: string): string {
    return terminalText(this.redactor.text(value)).slice(0, 4096);
  }
  private emit(
    onEvent: ((event: RuntimeEvent) => void) | undefined,
    stage: string,
    message: string
  ) {
    try {
      onEvent?.({ type: "progress", stage: this.safe(stage), message: this.safe(message) });
    } catch {
      /* View observers cannot interrupt installation or process cleanup. */
    }
  }
}
