import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeManager, type RuntimeEvent } from "../src/runtime";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function until(check: () => Promise<boolean> | boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Runtime fixture timed out");
    await new Promise((done) => setTimeout(done, 15));
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fixture(mode: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baas-runtime-test-"));
  const modeFile = join(directory, "mode.json");
  const helper = join(directory, "helper");
  const backend = join(directory, "backend.ts");
  const opens = join(directory, "opens.jsonl");
  const pidFile = join(directory, "backend.pid");
  const childPidFile = join(directory, "child.pid");
  const lateFile = join(directory, "late-child.txt");
  const protocol = new URL("../../packages/baas-client/src/pipe.ts", import.meta.url).pathname;
  await writeFile(modeFile, JSON.stringify(mode));
  await writeFile(
    backend,
    `
    import { createServer } from 'node:net';
    import { readFile, writeFile, appendFile } from 'node:fs/promises';
    import { encodePipeFrame, PipeFrameDecoder } from ${JSON.stringify(protocol)};
    const mode = JSON.parse(await readFile(${JSON.stringify(modeFile)}, 'utf8'));
    await writeFile(${JSON.stringify(pidFile)}, String(process.pid));
    if (mode.backendLine) console.log(mode.backendLine);
    if (mode.exitBackend) process.exit(8);
    const pipe = process.argv[process.argv.indexOf('--pipe-name') + 1];
    if (mode.stallBackend) { setInterval(() => {}, 1000); await new Promise(() => {}); }
    await new Promise(done => setTimeout(done, Number(mode.backendDelay || 20)));
    const server = createServer(socket => {
      const decoder = new PipeFrameDecoder();
      socket.on('error', () => {});
      socket.on('data', chunk => {
        for (const frame of decoder.feed(chunk)) {
          const message = JSON.parse(frame.payload.toString('utf8'));
          if (message.type === 'open') {
            void appendFile(${JSON.stringify(opens)}, JSON.stringify(message) + '\\n');
            socket.write(encodePipeFrame(1, Buffer.from(JSON.stringify({type:'open_ok',channel:message.channel}))));
          } else if (message.command === 'status') {
            void (async () => {
              const current = JSON.parse(await readFile(${JSON.stringify(modeFile)}, 'utf8'));
              const data = current.unknownStatus ? {fixture:{}} : {fixture:{running:!!current.running,current_task:current.running?'mail':null,waiting_tasks:[]}};
              socket.write(encodePipeFrame(1, Buffer.from(JSON.stringify({type:'command_response',command:message.command,timestamp:message.timestamp,status:'ok',data}))));
            })();
          }
        }
      });
    });
    server.listen(pipe);
  `
  );
  await writeFile(
    helper,
    `#!${process.execPath}
    import { spawn } from 'node:child_process';
    import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
    import { join } from 'node:path';
    const [command, ...args] = process.argv.slice(2);
    const value = key => args.includes(key) ? args[args.indexOf(key)+1] : undefined;
    const root = value('--root');
    const mode = JSON.parse(await readFile(${JSON.stringify(modeFile)}, 'utf8'));
    const output = value => console.log(JSON.stringify(value));
    const state = async () => ({
      installed: mode.installed ?? await access(join(root,'.installed')).then(()=>true,()=>false),
      managed: mode.managed ?? await access(join(root,'.installed')).then(()=>true,()=>false),
      root: mode.wrongRoot ? root + '-other' : root,
      backendPath:${JSON.stringify(backend)},pythonPath:${JSON.stringify(process.execPath)},cppPath:join(root,'ocr'),
      channel:value('--channel') || 'dev',missing:mode.missing || [],
    });
    if (mode.malformed) { console.log('not JSON'); process.exit(0); }
    if (mode.large) { console.log('x'.repeat(70000)); process.exit(0); }
    if (mode.error) { output({type:'error',code:'fixture_error',message:'api_key=fixture-secret'}); process.exit(1); }
    if (command === 'lease') {
      output({type:'result',data:{root,leased:true}});
      for await (const _ of Bun.stdin.stream()) {}
      process.exit(0);
    }
    if (command === 'install' || command === 'update') {
      if (mode.stallInstall) {
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => Bun.write('+JSON.stringify(${JSON.stringify(lateFile)})+', "late"),600); setInterval(()=>{},1000)'], {stdio:'ignore', detached: !!mode.detachedChild});
        await writeFile(${JSON.stringify(childPidFile)},String(child.pid));
        output({type:'progress',stage:'waiting',message:'waiting for child'});
        setInterval(()=>{},1000); await new Promise(()=>{});
      }
      output({type:'progress',stage:'python',message:'准备 Python 环境'});
      if (mode.progress) output({type:'progress',stage:'uv',message:'download 50%',...mode.progress});
      if (mode.stderrCR) process.stderr.write('download 10%\\rdownload 20%\\rready\\n');
      await mkdir(root,{recursive:true});
      await writeFile(join(root,'.installed'),'ready');
    }
    if (mode.noResult) { output({type:'progress',stage:'done',message:'no result'}); process.exit(0); }
    if (mode.splitStderr) {
      process.stderr.write('api_key=split-');
      await new Promise(done=>setTimeout(done,20));
      process.stderr.write('credential\\n');
    }
    const data = command === 'check-update' ? mode.checkResult || {
      root,channel:'dev',available:true,repositories:[
        {name:'backend',localVersion:'a'.repeat(40),remoteVersion:'b'.repeat(40),available:true},
        {name:'ocr',localVersion:'c'.repeat(40),remoteVersion:'c'.repeat(40),available:false},
      ]
    } : command === 'launch-spec' ? {
      program:mode.wrongProgram ? '/bin/sh' : ${JSON.stringify(process.execPath)},
      args:[${JSON.stringify(backend)},'--pipe-name',mode.wrongPipe ? 'other-pipe' : value('--pipe')],
      cwd:root,env:{PYTHONUNBUFFERED:'1'},
    } : await state();
    if (mode.splitUnicode) {
      const bytes = Buffer.from(JSON.stringify({type:'progress',stage:'python',message:'中文进度'})+'\\n');
      const start = bytes.indexOf(Buffer.from('中文'))+1;
      process.stdout.write(bytes.subarray(0,start));
      await new Promise(done=>setTimeout(done,20));
      process.stdout.write(bytes.subarray(start));
    }
    output({type:'result',data});
    if (mode.duplicate) output({type:'result',data});
    process.exit(mode.exitCode || 0);
  `,
    { mode: 0o700 }
  );
  const manager = new RuntimeManager({ directory, helperPath: helper });
  cleanups.push(async () => {
    manager.close();
    await new Promise((done) => setTimeout(done, 250));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    helper,
    manager,
    opens,
    pidFile,
    childPidFile,
    lateFile,
    mode: async (value: Record<string, unknown>) => writeFile(modeFile, JSON.stringify(value)),
  };
}

describe("local runtime installation", () => {
  test("missing helpers fail clearly without invoking cargo or writing an installed record", async () => {
    const fixture = new RuntimeManager({
      directory: join(tmpdir(), "baas-runtime-missing"),
      helperPath: "/missing/baas-runtime-helper",
    });
    try {
      await expect(fixture.inspect()).rejects.toMatchObject({ code: "helper_missing" });
    } finally {
      fixture.close();
    }
  });

  test("install verifies the real installation and persists only its root and channel privately", async () => {
    const target = await fixture();
    expect(await target.manager.inspect()).toMatchObject({ installed: false, managed: false });
    const events: RuntimeEvent[] = [];
    const root = join(target.directory, "custom runtime");
    const state = await target.manager.install({ root, channel: "dev" }, (event) =>
      events.push(event)
    );
    expect(state).toMatchObject({ root, installed: true, managed: true, channel: "dev" });
    expect(events.some((event) => event.message.includes("准备 Python 环境"))).toBe(true);
    expect(JSON.parse(await readFile(join(target.directory, "runtime.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      root,
      channel: "dev",
    });
    if (process.platform !== "win32")
      expect((await stat(join(target.directory, "runtime.json"))).mode & 0o777).toBe(0o600);
    const resumed = new RuntimeManager({ directory: target.directory, helperPath: target.helper });
    try {
      expect(await resumed.inspect()).toMatchObject({ root, installed: true });
    } finally {
      resumed.close();
    }
  });

  test.each([
    { malformed: true },
    { noResult: true },
    { duplicate: true },
    { large: true },
    { exitCode: 7 },
    { wrongRoot: true },
    { installed: false },
    { managed: false },
    { missing: ["python"] },
  ])("rejects incomplete, conflicting or malformed helper completion: %j", async (mode) => {
    const target = await fixture(mode);
    await expect(target.manager.install()).rejects.toThrow();
    expect(await exists(join(target.directory, "runtime.json"))).toBe(false);
  });

  test("helper errors and progress remain scrubbed and do not create success metadata", async () => {
    const target = await fixture({ error: true });
    await expect(target.manager.install()).rejects.toMatchObject({
      code: "fixture_error",
      message: "api_key=[REDACTED]",
    });
    expect(await exists(join(target.directory, "runtime.json"))).toBe(false);
  });

  test("UTF-8 progress survives a multibyte character split across process chunks", async () => {
    const target = await fixture({ splitUnicode: true });
    const events: RuntimeEvent[] = [];
    await target.manager.install({}, (event) => events.push(event));
    expect(events.some((event) => event.message === "中文进度")).toBe(true);
    expect(events.every((event) => !event.message.includes("�"))).toBe(true);
  });

  test("stderr credentials stay redacted when an assignment is split between process chunks", async () => {
    const target = await fixture({ splitStderr: true });
    const events: RuntimeEvent[] = [];
    await target.manager.install({}, (event) => events.push(event));
    const diagnostics = events
      .filter((event) => event.stage === "installer")
      .map((event) => event.message)
      .join("\n");
    expect(diagnostics).toContain("[REDACTED]");
    expect(diagnostics).not.toContain("credential");
  });

  test.skipIf(process.platform === "win32").each([false, true])(
    "cancelling install terminates its child process group and never marks it installed",
    async (detachedChild) => {
      const target = await fixture({ stallInstall: true, detachedChild });
      const controller = new AbortController();
      const installing = target.manager.install(
        {},
        (event) => {
          if (event.stage === "waiting")
            controller.abort(new DOMException("cancel fixture", "AbortError"));
        },
        controller.signal
      );
      await expect(installing).rejects.toMatchObject({ name: "AbortError" });
      const childPid = Number(await readFile(target.childPidFile, "utf8"));
      await until(() => !alive(childPid));
      await new Promise((done) => setTimeout(done, 650));
      expect(await exists(target.lateFile)).toBe(false);
      expect(await exists(join(target.directory, "runtime.json"))).toBe(false);
    }
  );
});

describe("owned local backend", () => {
  const actualHelper = join(
    import.meta.dir,
    "../../target/debug",
    process.platform === "win32" ? "baas-cli-runtime.exe" : "baas-cli-runtime"
  );
  test.skipIf(process.platform === "win32" || !existsSync(actualHelper))(
    "the built Rust helper and Bun manager agree on inspect and launch-spec without downloads",
    async () => {
      const target = await fixture();
      const root = join(target.directory, "runtime");
      for (const file of [
        "main.service.py",
        ".venv/bin/python",
        "toolkit/uv/uv",
        "core/ocr/baas_ocr_client/bin/BAAS_ocr_server",
        "requirements.service.lock",
        ".baas-cli-install.lock",
      ]) {
        await mkdir(join(root, file, ".."), { recursive: true });
        await writeFile(join(root, file), "# --pipe-name fixture\n", { mode: 0o700 });
      }
      await writeFile(
        join(root, ".venv/bin/python"),
        `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nconst child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(join(target.directory, "backend.ts"))},...process.argv.slice(3)],{stdio:'inherit'});\nchild.on('exit',code=>process.exit(code||0));\n`,
        { mode: 0o700 }
      );
      await writeFile(
        join(root, "setup.toml"),
        `[paths]\nbaas_root_path = ${JSON.stringify(root)}\n[general]\nchannel = "dev"\n`
      );
      await writeFile(
        join(root, ".baas-cli-runtime.json"),
        JSON.stringify({
          owner: "baas-cli-runtime",
          schemaVersion: 1,
          root,
          channel: "dev",
          complete: true,
        })
      );
      const manager = new RuntimeManager({ directory: target.directory, helperPath: actualHelper });
      try {
        expect(await manager.inspect()).toMatchObject({
          installed: true,
          managed: true,
          root,
          missing: [],
        });
        const connection = await manager.start();
        expect(await exists(connection.pipe)).toBe(true);
        const marker = await readFile(join(root, ".baas-cli-runtime.json"), "utf8");
        const competing = Bun.spawn([actualHelper, "update", "--root", root], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const competingOutput = await new Response(competing.stdout).text();
        expect(await competing.exited).toBe(1);
        expect(JSON.parse(competingOutput).message).toContain("another installer");
        expect(await readFile(join(root, ".baas-cli-runtime.json"), "utf8")).toBe(marker);
        await manager.stopWhenIdle();

        // Simulate a CLI losing its stdin while its detached backend is alive.
        const detachedBackend = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], {
          stdout: "ignore",
          stderr: "ignore",
        });
        const orphanLease = Bun.spawn([actualHelper, "lease", "--root", root], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        try {
          const reader = orphanLease.stdout.getReader();
          let response = "";
          while (!response.includes("\n")) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error("Lease exited without acknowledging ownership");
            response += new TextDecoder().decode(chunk.value);
          }
          expect(JSON.parse(response.trim()).data.leased).toBe(true);
          reader.releaseLock();
          orphanLease.stdin.write(`${detachedBackend.pid}\n`);
          await orphanLease.stdin.end();
          await Bun.sleep(150);
          expect(orphanLease.exitCode).toBeNull();
          const blocked = Bun.spawn([actualHelper, "update", "--root", root], {
            stdout: "pipe",
            stderr: "pipe",
          });
          expect(JSON.parse(await new Response(blocked.stdout).text()).message).toContain(
            "another installer"
          );
          expect(await blocked.exited).toBe(1);
          detachedBackend.kill();
          await detachedBackend.exited;
          expect(
            await Promise.race([
              orphanLease.exited,
              Bun.sleep(3000).then(() => "lease did not release"),
            ])
          ).toBe(0);
        } finally {
          detachedBackend.kill();
          if (orphanLease.exitCode === null) orphanLease.kill();
        }
      } finally {
        manager.close();
      }
    }
  );

  test("start waits for all BAAS pipe handshakes, reuses its owned process, and close removes it", async () => {
    const target = await fixture({ backendLine: "backend initialization" });
    await target.manager.install();
    const events: RuntimeEvent[] = [];
    const connection = await target.manager.start((event) => events.push(event));
    const again = await target.manager.start();
    expect(again).toEqual(connection);
    expect(events[0]).toMatchObject({ taskId: "launch-backend", status: "running" });
    expect(events.find((event) => event.message === "backend initialization")).toMatchObject({
      taskId: "launch-backend",
    });
    expect(events.at(-1)).toMatchObject({
      taskId: "launch-backend",
      status: "complete",
      stage: "ready",
      percent: 100,
    });
    await until(async () => (await readFile(target.opens, "utf8")).trim().split("\n").length >= 3);
    expect(
      (await readFile(target.opens, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).channel)
    ).toEqual(["provider", "sync", "trigger"]);
    const pid = Number(await readFile(target.pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    target.manager.close();
    await until(() => !alive(pid));
    if (process.platform !== "win32") await until(async () => !(await exists(connection.pipe)));
  });

  test.each([{ wrongPipe: true }, { wrongProgram: true }])(
    "rejects mismatched launch plans: %j",
    async (mode) => {
      const target = await fixture();
      await target.manager.install();
      await target.mode(mode);
      await expect(target.manager.start()).rejects.toMatchObject({ code: "runtime_protocol" });
      expect(await exists(target.pidFile)).toBe(false);
    }
  );

  test("a backend exit before handshake is a failure rather than ready", async () => {
    const target = await fixture();
    await target.manager.install();
    await target.mode({ exitBackend: true });
    const events: RuntimeEvent[] = [];
    await expect(target.manager.start((event) => events.push(event))).rejects.toMatchObject({
      code: "backend_exit",
    });
    expect(events.some((event) => event.stage === "ready")).toBe(false);
    expect(events.at(-1)).toMatchObject({ taskId: "launch-backend", status: "failed" });
  });

  test("cancelling readiness stops only the manager's own backend", async () => {
    const target = await fixture();
    await target.manager.install();
    await target.mode({ stallBackend: true });
    const other: ChildProcess = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    cleanups.push(async () => {
      other.kill();
    });
    const controller = new AbortController();
    const starting = target.manager.start(undefined, controller.signal);
    await until(async () => exists(target.pidFile));
    const pid = Number(await readFile(target.pidFile, "utf8"));
    controller.abort(new DOMException("cancel fixture", "AbortError"));
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await until(() => !alive(pid));
    expect(other.pid && alive(other.pid)).toBe(true);
  });

  test("a null cancellation reason still cleans up the owned backend and finishes its launch step", async () => {
    const target = await fixture({ stallBackend: true });
    await target.manager.install();
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    const starting = target.manager.start((event) => events.push(event), controller.signal);
    await until(async () => exists(target.pidFile));
    const pid = Number(await readFile(target.pidFile, "utf8"));
    controller.abort(null);
    expect(
      await starting.then(
        () => false,
        () => true
      )
    ).toBe(true);
    await until(() => !alive(pid));
    expect(events.at(-1)).toMatchObject({ taskId: "launch-backend", status: "failed" });
  });
});

describe("managed runtime updates and structured progress", () => {
  test("structured progress preserves true metrics and stderr CR frames request replacement", async () => {
    const target = await fixture({
      progress: {
        taskId: "uv-install",
        status: "running",
        percent: 50,
        current: 5,
        total: 10,
        unit: "bytes",
        downloadedBytes: 5,
        totalBytes: 10,
        currentLine: "api_key=private",
        replace: true,
      },
      stderrCR: true,
    });
    const events: RuntimeEvent[] = [];
    await target.manager.install({}, (event) => events.push(event));
    expect(events.find((event) => event.taskId === "uv-install")).toMatchObject({
      percent: 50,
      current: 5,
      total: 10,
      downloadedBytes: 5,
      replace: true,
      currentLine: "api_key=[REDACTED]",
    });
    expect(events.filter((event) => event.stage === "installer")).toMatchObject([
      { message: "download 10%", replace: true },
      { message: "download 20%", replace: true },
      { message: "ready", replace: false },
    ]);
  });

  test.each([
    { percent: 101 },
    { percent: -1 },
    { current: 20, total: 10 },
    { unit: "seconds" },
    { replace: "true" },
    { status: "success" },
    { taskId: 5 },
    { downloadedBytes: 11, totalBytes: 10 },
  ])("invalid progress is rejected: %j", async (progress) => {
    const target = await fixture({ progress });
    await expect(target.manager.install()).rejects.toMatchObject({ code: "runtime_protocol" });
  });

  test("version checks are read-only and managed updates re-inspect completion", async () => {
    const target = await fixture();
    await target.manager.install();
    const metadata = await readFile(join(target.directory, "runtime.json"), "utf8");
    const result = await target.manager.checkUpdates();
    expect(result).toMatchObject({
      channel: "dev",
      available: true,
      repositories: [
        { name: "backend", available: true },
        { name: "ocr", available: false },
      ],
    });
    expect(await readFile(join(target.directory, "runtime.json"), "utf8")).toBe(metadata);
    expect(await target.manager.update()).toMatchObject({ installed: true, managed: true });
  });

  test("update failures never publish an installed state or stop an owned backend", async () => {
    const target = await fixture();
    await expect(target.manager.update()).rejects.toMatchObject({ code: "runtime_missing" });
    await target.manager.install();
    await target.manager.start();
    const pid = Number(await readFile(target.pidFile, "utf8"));
    await expect(target.manager.update()).rejects.toMatchObject({ code: "runtime_busy" });
    expect(alive(pid)).toBe(true);
    await target.mode({ running: true });
    await expect(target.manager.stopWhenIdle()).rejects.toMatchObject({ code: "runtime_busy" });
    expect(alive(pid)).toBe(true);
    await target.mode({ unknownStatus: true });
    await expect(target.manager.stopWhenIdle()).rejects.toMatchObject({ code: "runtime_busy" });
    expect(alive(pid)).toBe(true);
    await target.mode({});
    await target.manager.stopWhenIdle();
    await until(() => !alive(pid));
    expect(await target.manager.update()).toMatchObject({ installed: true });
    const restarted = await target.manager.start();
    expect(restarted.pipe).toBeTruthy();
  });

  test("malformed update summaries cannot claim an available or completed update", async () => {
    const target = await fixture({
      checkResult: { root: "/other", channel: "dev", available: false, repositories: [] },
    });
    await expect(target.manager.checkUpdates()).rejects.toMatchObject({ code: "runtime_protocol" });
  });
});
