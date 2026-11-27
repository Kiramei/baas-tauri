// The worker owns the Ink tree, client and local runtime. Terminals only forward
// input and display frames, so replacing a terminal never replays a BAAS action.
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkspaceOptions } from "./workspace";

type Options = WorkspaceOptions & { directory: string; noColor?: boolean };
export interface SessionTerminal {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  detach(): void;
}
const enter = "\x1b[?1049h\x1b[H\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?25l";
const leave = "\x1b[?1004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l";
const codeOf = (e: unknown) => (e as NodeJS.ErrnoException).code;

async function endpoint(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = createHash("sha256")
    .update(await realpath(directory))
    .digest("hex")
    .slice(0, 24);
  if (process.platform === "win32") {
    // Named pipes are enumerable. Keep the authentication key off the wire.
    const file = join(directory, ".session-key");
    try {
      await writeFile(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch (e) {
      if (codeOf(e) !== "EEXIST") throw e;
    }
    for (let i = 0; i < 10; i++) {
      const key = await readFile(file, "utf8");
      if (/^[a-f0-9]{64}$/.test(key)) return { path: `\\\\.\\pipe\\baasx-${id}`, key };
      await delay(10);
    }
    throw new Error("Invalid BAASX session key");
  }
  const uid = process.getuid!();
  const dir = join(process.platform === "darwin" ? "/tmp" : tmpdir(), `baasx-${uid}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.uid !== uid || stat.mode & 0o077)
    throw new Error(`Session directory must be private: ${dir}`);
  return { path: join(dir, id), key: undefined };
}

// Each side proves it knows the configuration key before allowing input.
function proof(key: string | undefined, role: string, nonce: string) {
  return key
    ? createHmac("sha256", key)
        .update(role + nonce)
        .digest("hex")
    : "";
}

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("error", reject);
    socket.once("connect", () => resolve(socket));
  });
}

// Only short JSON control/input records flow towards the worker. Screen data
// flows as raw bytes after a single response line.
function readLines(socket: Socket, receive: (value: Record<string, unknown>) => void) {
  socket.setEncoding("utf8");
  let pending = "";
  socket.on("data", (chunk: string) => {
    pending += chunk;
    let end: number;
    try {
      while ((end = pending.indexOf("\n")) >= 0) {
        if (end > 256_000) throw new Error();
        const message = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        receive(message);
      }
      if (pending.length > 256_000) socket.destroy();
    } catch {
      socket.destroy();
    }
  });
}

const bounded = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isInteger(value)
    ? Math.max(1, Math.min(2000, value))
    : fallback;

export async function hostSession(
  path: string,
  options: Options,
  launch: (io: SessionTerminal) => Promise<void>
) {
  const { key } = await endpoint(options.directory);
  let owner: Socket | undefined;
  let started = false;
  let frame = "";
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        const data = String(chunk);
        if (data.startsWith("\x1b[H") || process.env.TERM === "dumb") frame = data;
        if (owner && !owner.destroyed) {
          if (owner.writableLength > 4_000_000) owner.destroy();
          else owner.write(chunk);
        }
        done();
      },
    }),
    { isTTY: true, columns: 80, rows: 24 }
  );
  const detach = () => {
    owner?.end();
    owner = undefined;
    output.emit("attached", false);
  };
  const io = {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    detach,
  };
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      if (owner === socket) detach();
    });
    const nonce = randomBytes(24).toString("hex");
    socket.write(nonce + "\n");
    let attached = false;
    readLines(socket, (m) => {
      if (!attached) {
        if (
          m.type !== "attach" ||
          typeof m.nonce !== "string" ||
          m.proof !== proof(key, "client", nonce + m.nonce)
        )
          return socket.destroy();
        if (owner && !m.force)
          return socket.end("Session already attached. Use baasx attach -f.\n");
        // Explicit connection or safety flags must not be silently discarded.
        const constraints = m.options as Partial<Options> | undefined;
        const keys = ["demo", "readOnly", "dryRun", "server", "pipe", "profile", "yes"] as const;
        if (keys.some((key) => constraints?.[key] && options[key] !== constraints[key]))
          return socket.end(
            "Session options differ. Use a different --config-home or close the existing session.\n"
          );
        detach();
        owner = socket;
        output.emit("attached", true);
        attached = true;
        socket.write("OK" + proof(key, "server", m.nonce) + "\n");
        output.columns = bounded(m.columns, 80);
        output.rows = bounded(m.rows, 24);
        if (started) {
          if (process.env.TERM !== "dumb") socket.write(enter);
          if (frame) socket.write(frame);
          output.emit("resize");
          return;
        }
        started = true;
        clearTimeout(unclaimed);
        void launch(io)
          .catch((e) => {
            process.exitCode = 1;
            owner?.write(String(e instanceof Error ? e.message : e));
          })
          .finally(() => {
            detach();
            server.close();
          });
      } else if (owner === socket) {
        if (m.type === "input" && typeof m.data === "string")
          input.write(Buffer.from(m.data, "base64"));
        if (m.type === "resize") {
          output.columns = bounded(m.columns, output.columns);
          output.rows = bounded(m.rows, output.rows);
          output.emit("resize");
        }
      }
    });
  });
  const unclaimed = setTimeout(() => server.close(), 15000);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    process.stdout.write("READY\n");
  } catch (e) {
    clearTimeout(unclaimed);
    if (codeOf(e) !== "EADDRINUSE") throw e;
    process.stdout.write("IN_USE\n");
  }
}

// Deno does not expose its run flags in process.execArgv. Never add a broader
// permission to a detached worker (or to a reinstalled launcher).
export function denoPermissionFlags(): string[] {
  const deno = (
    globalThis as typeof globalThis & {
      Deno?: { permissions: { querySync(descriptor: { name: string }): { state: string } } };
    }
  ).Deno;
  if (!deno) return ["-A"];
  const names = ["read", "write", "net", "env", "sys", "run", "ffi", "import"];
  const granted = names.filter((name) => {
    try {
      return deno.permissions.querySync({ name }).state === "granted";
    } catch {
      return false;
    }
  });
  return granted.length === names.length ? ["-A"] : granted.map((name) => "--allow-" + name);
}

function startWorker(path: string): Promise<string> {
  const binary = isStandalone();
  const deno = process.versions.deno;
  const args = [
    ...(binary
      ? []
      : deno
        ? ["run", ...denoPermissionFlags(), "--no-prompt", process.argv[1]]
        : [process.argv[1]]),
    ...process.argv.slice(2),
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, BAASX_SESSION_WORKER: path },
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Could not start BAASX session")));
    child.stdout!.once("data", (chunk) => {
      child.stdout!.destroy();
      child.unref();
      resolve(String(chunk).trim());
    });
  });
}

export function isStandalone() {
  return (
    /(?:^|[/\\])(?:\$bunfs|~BUN)(?:[/\\]|$)/i.test(import.meta.url) ||
    /(?:^|[/\\])(?:\$bunfs|~BUN)(?:[/\\]|$)/i.test(process.argv[1] || "")
  );
}

async function findSession(directory: string, attachOnly: boolean) {
  const { path: base, key } = await endpoint(directory);
  // A killed Unix worker can leave a socket inode. Try a new generation only
  // after the kernel rejects both connect and bind. Never unlink a live socket.
  for (let slot = 0; slot < 100; slot++) {
    const path = `${base}-${slot}`;
    try {
      return { socket: await connect(path), key };
    } catch (e) {
      if (!["ENOENT", "ECONNREFUSED"].includes(codeOf(e) || "")) throw e;
      if (attachOnly) {
        if (codeOf(e) === "ECONNREFUSED") continue;
        throw new Error("No BAASX session to attach");
      }
    }
    const result = await startWorker(path);
    try {
      return { socket: await connect(path), key };
    } catch (e) {
      if (result !== "IN_USE" || codeOf(e) !== "ECONNREFUSED") throw e;
    }
  }
  throw new Error("Unable to allocate BAASX session socket");
}

export async function attachTerminal(options: Options, attachOnly: boolean, force: boolean) {
  const { socket, key } = await findSession(options.directory, attachOnly);
  const { stdin, stdout } = process;
  const wasRaw = !!stdin.isRaw;
  const fullscreen = process.env.TERM !== "dumb";
  let attached = false;
  const send = (message: object) => {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
  };
  const input = (chunk: Buffer) => {
    for (let i = 0; i < chunk.length; i += 16384)
      send({ type: "input", data: chunk.subarray(i, i + 16384).toString("base64") });
  };
  const resize = () => send({ type: "resize", columns: stdout.columns, rows: stdout.rows });
  const close = () => socket.destroy();
  try {
    const challenge = randomBytes(24).toString("hex");
    let greeted = false;
    let reply = "";
    socket.setEncoding("utf8");
    for await (const chunk of socket) {
      let data = String(chunk);
      if (!attached) {
        reply += data;
        const end = reply.indexOf("\n");
        if (end < 0) continue;
        const line = reply.slice(0, end);
        if (!greeted) {
          if (!/^[a-f0-9]{48}$/.test(line)) throw new Error("Invalid BAASX session greeting");
          greeted = true;
          send({
            type: "attach",
            force,
            nonce: challenge,
            proof: proof(key, "client", line + challenge),
            columns: stdout.columns,
            rows: stdout.rows,
            options: {
              demo: options.demo,
              readOnly: options.readOnly,
              dryRun: options.dryRun,
              yes: options.yes,
              server: options.server,
              pipe: options.pipe,
              profile: options.profile,
            },
          });
          reply = "";
          continue;
        }
        if (line !== "OK" + proof(key, "server", challenge)) throw new Error(line);
        attached = true;
        data = reply.slice(end + 1);
        reply = "";
        stdin.setRawMode(true);
        stdin.on("data", input);
        stdout.on("resize", resize);
        process.once("SIGTERM", close);
        process.once("SIGHUP", close);
      }
      if (data) stdout.write(data);
    }
    if (!attached) throw new Error("BAASX session closed before attachment");
  } finally {
    socket.destroy();
    if (attached) {
      stdin.off("data", input);
      stdin.pause();
      stdin.setRawMode(wasRaw);
      stdout.off("resize", resize);
      process.off("SIGTERM", close);
      process.off("SIGHUP", close);
      if (fullscreen) stdout.write(leave);
    }
  }
}
