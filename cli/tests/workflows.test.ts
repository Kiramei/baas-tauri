import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { saveSettings } from "../src/settings";

const temporary: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "baas-workflows-"));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function cli(
  root: string,
  args: string[],
  environment: Record<string, string | undefined> = {}
) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("BAAS_")) delete env[key];
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../src/index.ts"),
      "--config-home",
      root,
      "--json",
      ...args,
    ],
    {
      env: { ...env, ...environment },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error(`CLI workflow hung: ${args.join(" ")}`));
        }, 4000);
      }),
    ]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(stdout).not.toContain("\x1b");
    return { data: JSON.parse(lines[0]) as Record<string, any>, stdout, stderr, code };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}

async function pack(root: string, name: string, steps: unknown[]) {
  await mkdir(join(root, "commands"), { recursive: true });
  await writeFile(
    join(root, "commands", "workflow.json"),
    JSON.stringify({
      id: "workflow-checks",
      name: "流程测试",
      description: "验证执行边界",
      version: 1,
      commands: [{ name, description: "验证计划", steps }],
    })
  );
}

async function localFixture(
  options: {
    metadata?: boolean;
    installed?: boolean;
    invalidCreatedId?: boolean;
    duplicateDuringApproval?: string;
    completeAfterMs?: number;
    updatesAvailable?: boolean;
  } = {}
) {
  const root = await directory(),
    managed = join(root, "managed");
  await mkdir(managed);
  const helper = join(root, "runtime-helper"),
    backend = join(root, "backend.ts");
  const calls = join(root, "helper-calls.jsonl"),
    commands = join(root, "commands.jsonl"),
    pidFile = join(root, "backend.pid");
  const protocol = new URL("../../packages/baas-client/src/pipe.ts", import.meta.url).pathname;
  await writeFile(
    backend,
    `
    import { createServer } from "node:net";
    import { appendFile, writeFile } from "node:fs/promises";
    import { encodePipeFrame, PipeFrameDecoder } from ${JSON.stringify(protocol)};
    await writeFile(${JSON.stringify(pidFile)}, String(process.pid));
    const configs = {"local-id":{name:"本地配置"}};
    const state={running:false,run_id:null,exit_code:null,current_task:null};
    const providers=new Set();
    const publish=()=>{for(const socket of providers)socket.write(encodePipeFrame(1,Buffer.from(JSON.stringify({type:"status",status:{"local-id":state}}))));};
    let lists=0;
    const server=createServer(socket=>{
      const decoder=new PipeFrameDecoder();
      const send=value=>socket.write(encodePipeFrame(1,Buffer.from(JSON.stringify(value))));
      socket.on("error",()=>{});
      socket.on("data",chunk=>{for(const frame of decoder.feed(chunk)){
        const message=JSON.parse(frame.payload.toString("utf8"));
        if(message.type==="open"){
          send({type:"open_ok",channel:message.channel});
          if(message.channel==="provider"){providers.add(socket);socket.on("close",()=>providers.delete(socket));}
        }
        else if(message.type==="list"){
          lists++;
          if(${JSON.stringify(options.duplicateDuringApproval || "")} && lists===2)configs["other-id"]={name:${JSON.stringify(options.duplicateDuringApproval || "")}};
          send({type:"config_list",data:Object.keys(configs)});
        }else if(message.type==="pull")send({type:"snapshot",resource:message.resource,resource_id:message.resource_id,timestamp:Date.now(),data:message.resource==="event"?[{func_name:"fixture_task",event_name:"测试任务"}]:configs[message.resource_id]});
        else if(message.type==="command"){
          void appendFile(${JSON.stringify(commands)},JSON.stringify(message)+"\\n");
          let data={};
          if(message.command==="add_config"){
            configs["created-id"]={name:message.payload.name,server:message.payload.server};
            data=${JSON.stringify(options.invalidCreatedId)}?{}:{serial:"created-id"};
          }else if(message.command==="status")data={"local-id":state};
          else if(["solve","start_scheduler"].includes(message.command)){
            Object.assign(state,{running:true,run_id:"fixture-run",exit_code:null,current_task:"fixture_task"});publish();
            data={status:"started",config_id:"local-id",run_id:"fixture-run"};
            if(${JSON.stringify(options.completeAfterMs !== undefined)})setTimeout(()=>{Object.assign(state,{running:false,exit_code:0,current_task:null});publish();},${JSON.stringify(options.completeAfterMs || 0)});
          }
          send({type:"command_response",command:message.command,timestamp:message.timestamp,status:"ok",data});
        }
      }});
    });
    server.listen(process.argv[process.argv.indexOf("--pipe-name")+1]);
  `
  );
  await writeFile(
    helper,
    `#!${process.execPath}
    import { appendFile } from "node:fs/promises";
    const [command,...args]=process.argv.slice(2);
    await appendFile(${JSON.stringify(calls)},JSON.stringify({command,args})+"\\n");
    const value=name=>args[args.indexOf(name)+1];
    if(command==="lease"){console.log(JSON.stringify({type:"result",data:{root:value("--root"),leased:true}}));for await(const _ of Bun.stdin.stream()){};process.exit(0);}
    if(command==="check-update"){console.log(JSON.stringify({type:"progress",stage:"check-backend",message:"Checking fixture backend",status:"complete"}));console.log(JSON.stringify({type:"result",data:{root:value("--root"),channel:"dev",available:${options.updatesAvailable ?? true},repositories:[{name:"backend",localVersion:"${"a".repeat(40)}",remoteVersion:"${(options.updatesAvailable ?? true) ? "b".repeat(40) : "a".repeat(40)}",available:${options.updatesAvailable ?? true}},{name:"ocr",localVersion:"${"c".repeat(40)}",remoteVersion:"${"c".repeat(40)}",available:false}]}}));process.exit(0);}
    const data=command==="launch-spec"?{program:${JSON.stringify(process.execPath)},args:[${JSON.stringify(backend)},"--pipe-name",value("--pipe")],cwd:value("--root"),env:{}}:{installed:${options.installed ?? true},managed:true,root:value("--root"),backendPath:${JSON.stringify(backend)},pythonPath:${JSON.stringify(process.execPath)},cppPath:${JSON.stringify(join(managed, "ocr"))},channel:"dev",missing:[]};
    console.log(JSON.stringify({type:"result",data}));
  `,
    { mode: 0o700 }
  );
  if (options.metadata)
    await writeFile(
      join(root, "runtime.json"),
      JSON.stringify({ schemaVersion: 1, root: managed, channel: "dev" })
    );
  else await mkdir(join(root, "runtime"));
  return {
    root,
    helper,
    backend,
    calls,
    commands,
    pidFile,
    environment: { BAAS_RUNTIME_HELPER: helper },
    async helperCalls() {
      return readFile(calls, "utf8").then(
        (text) =>
          text
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        () => []
      );
    },
    async submitted() {
      return readFile(commands, "utf8").then(
        (text) =>
          text
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        () => []
      );
    },
    async stopped() {
      const pid = Number(await readFile(pidFile, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    },
  };
}

describe("complete CLI workflows", () => {
  test("scriptable update checks and confirmed updates use local metadata without connecting or changing saved remote mode", async () => {
    const target = await localFixture({ metadata: true });
    await saveSettings(
      { url: "ws://remote.invalid:8190", connectionMode: "remote", profile: "remote-id" },
      target.root
    );
    const check = await cli(target.root, ["--read-only", "check-update"], target.environment);
    expect(check.code).toBe(0);
    expect(check.data).toMatchObject({ available: true, root: join(target.root, "managed") });
    expect((await target.helperCalls()).map((call) => call.command)).toEqual(["check-update"]);
    expect(existsSync(target.pidFile)).toBe(false);
    const update = await cli(target.root, ["--yes", "update"], target.environment);
    expect(update.code).toBe(0);
    expect(update.data).toMatchObject({
      updated: true,
      runtime: { installed: true, managed: true },
    });
    expect((await target.helperCalls()).map((call) => call.command)).toEqual([
      "check-update",
      "check-update",
      "inspect",
      "update",
      "inspect",
    ]);
    expect(existsSync(target.pidFile)).toBe(false);
    expect(await target.submitted()).toEqual([]);
    expect(JSON.parse(await readFile(join(target.root, "settings.json"), "utf8"))).toMatchObject({
      url: "ws://remote.invalid:8190",
      connectionMode: "remote",
      profile: "remote-id",
    });
  });
  test("local updates require confirmation, honor dry-run and read-only, and skip already-current environments", async () => {
    for (const args of [["update"], ["--dry-run", "update"], ["--read-only", "--yes", "update"]]) {
      const target = await localFixture({ metadata: true });
      const result = await cli(target.root, args, target.environment);
      expect(result.code).toBe(args.includes("--dry-run") ? 0 : 1);
      if (args.includes("--dry-run"))
        expect(result.data).toMatchObject({ dry_run: true, action: "update", available: true });
      expect((await target.helperCalls()).map((call) => call.command)).toEqual(
        args.includes("--read-only") ? [] : ["check-update"]
      );
      expect(existsSync(target.pidFile)).toBe(false);
    }
    const current = await localFixture({ metadata: true, updatesAvailable: false });
    const result = await cli(current.root, ["update"], current.environment);
    expect(result.code).toBe(0);
    expect(result.data).toMatchObject({
      updated: false,
      reason: "already-current",
      available: false,
    });
    expect((await current.helperCalls()).map((call) => call.command)).toEqual(["check-update"]);
    const demo = await cli(await directory(), ["--demo", "update"]);
    expect(demo.code).toBe(1);
  });
  test("profile creation requires approval and respects readonly, dry-run and name/server validation", async () => {
    const root = await directory();
    const dry = await cli(root, ["--demo", "--dry-run", "profile", "create", "新主号", "官服"]);
    expect(dry.code).toBe(0);
    expect(dry.data).toEqual({
      dry_run: true,
      action: "add_config",
      name: "新主号",
      server: "官服",
    });
    const denied = await cli(root, ["--demo", "profile", "create", "新主号", "官服"]);
    expect(denied.code).toBe(1);
    expect(denied.data.error).toContain("--yes");
    const readonly = await cli(root, [
      "--demo",
      "--read-only",
      "profile",
      "create",
      "新主号",
      "官服",
    ]);
    expect(readonly.code).toBe(1);
    expect(readonly.data.error).toContain("只读");
    const created = await cli(root, ["--demo", "--yes", "profile", "create", "  新主号  ", "官服"]);
    expect(created.code).toBe(0);
    expect(created.data).toMatchObject({ created: true, name: "新主号", server: "官服" });
    expect(created.data.profile).toBe(created.data.result.serial);
    for (const args of [
      ["新主号", "CN"],
      ["夏莱 · 国服", "官服"],
      ["", "官服"],
      ["bad\x1b[2J", "官服"],
    ]) {
      const invalid = await cli(root, ["--demo", "--yes", "profile", "create", ...args]);
      expect(invalid.code).toBe(1);
      expect(invalid.data.error).toBeTypeOf("string");
    }
  });

  test.skipIf(process.platform === "win32")(
    "local preference lazily starts a private backend and closes it after command success or failure",
    async () => {
      for (const args of [["profiles"], ["config", "get", "/missing"]]) {
        const target = await localFixture();
        await saveSettings(
          { url: "ws://unused.invalid", connectionMode: "local", profile: "local-id" },
          target.root
        );
        const result = await cli(target.root, args, target.environment);
        expect(result.code).toBe(args[0] === "profiles" ? 0 : 1);
        if (args[0] === "profiles") expect(result.data).toEqual({ "local-id": "本地配置" });
        expect((await target.helperCalls()).map((call) => call.command)).toEqual([
          "inspect",
          "lease",
          "launch-spec",
        ]);
        await target.stopped();
      }
    }
  );

  test.skipIf(process.platform === "win32")(
    "runtime metadata enables implicit local commands, including profile creation and saved selection",
    async () => {
      const target = await localFixture({ metadata: true });
      const result = await cli(
        target.root,
        ["--yes", "profile", "create", "新本地档", "官服"],
        target.environment
      );
      expect(result.code).toBe(0);
      expect(result.data).toMatchObject({
        created: true,
        profile: "created-id",
        name: "新本地档",
        server: "官服",
      });
      expect((await target.submitted()).map((call) => call.command)).toEqual(["add_config"]);
      expect(JSON.parse(await readFile(join(target.root, "settings.json"), "utf8")).profile).toBe(
        "created-id"
      );
      await target.stopped();
    }
  );

  test.skipIf(process.platform === "win32")(
    "local tasks wait for delayed completion by default before closing their owned backend",
    async () => {
      const target = await localFixture({ metadata: true, completeAfterMs: 200 });
      const result = await cli(
        target.root,
        ["--profile", "local-id", "--yes", "run", "fixture_task"],
        target.environment
      );
      expect(result.code).toBe(0);
      expect(result.data).toMatchObject({
        accepted: true,
        completed: true,
        succeeded: true,
        run_id: "fixture-run",
        status: { running: false, exit_code: 0 },
      });
      expect((await target.submitted()).filter((call) => call.command === "solve")).toHaveLength(1);
      await target.stopped();
    }
  );

  test.skipIf(process.platform === "win32")(
    "local wait timeout honors its explicit limit and reports owned-backend shutdown",
    async () => {
      const target = await localFixture({ metadata: true });
      const result = await cli(
        target.root,
        ["--profile", "local-id", "--yes", "--wait-timeout", "1", "start"],
        target.environment
      );
      expect(result.code).toBe(124);
      expect(result.data).toMatchObject({
        code: "wait_timeout",
        details: { owned_backend_stopped: true },
      });
      expect(result.data.error).toContain("自有后端");
      expect(result.data.error).not.toContain("仍可能");
      await target.stopped();
    }
  );

  test.skipIf(process.platform === "win32")(
    "local command packs wait for their task before proceeding to later reads",
    async () => {
      const target = await localFixture({ metadata: true, completeAfterMs: 200 });
      await pack(target.root, "local-flow", [
        { action: "task_run", args: { task: "fixture_task" } },
        { action: "status", args: {} },
      ]);
      const result = await cli(
        target.root,
        ["--profile", "local-id", "--yes", "pack", "local-flow"],
        target.environment
      );
      expect(result.code).toBe(0);
      expect(result.data.results[0].result).toMatchObject({ completed: true, succeeded: true });
      expect(result.data.results[1].result["local-id"].running).toBe(false);
      await target.stopped();
    }
  );

  test.skipIf(process.platform === "win32")(
    "cancelled local waits report shutdown and leave no owned backend running",
    async () => {
      const target = await localFixture({ metadata: true });
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith("BAAS_")) delete env[key];
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../src/index.ts"),
          "--config-home",
          target.root,
          "--json",
          "--profile",
          "local-id",
          "--yes",
          "start",
        ],
        { env: { ...env, ...target.environment }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = Date.now() + 3000;
        while (!(await target.submitted()).some((call) => call.command === "start_scheduler")) {
          if (Date.now() > deadline) throw new Error("local start was not submitted");
          await Bun.sleep(20);
        }
        child.kill("SIGINT");
        const [stdout, code] = await Promise.race([
          Promise.all([new Response(child.stdout).text(), child.exited]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("local cancellation hung")), 3000);
          }),
        ]);
        expect(code).toBe(130);
        const result = JSON.parse(stdout);
        expect(result.error).toContain("自有后端");
        expect(result.error).not.toContain("仍可能");
        await target.stopped();
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill();
        const pid = await readFile(target.pidFile, "utf8").then(Number, () => 0);
        if (pid)
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            /* The owned backend was already stopped. */
          }
      }
    }
  );

  test.skipIf(process.platform === "win32")(
    "preference-only commands and explicit demo/server/pipe/environment targets never start local runtime",
    async () => {
      const target = await localFixture({ metadata: true });
      await saveSettings({ url: "ws://saved.invalid", connectionMode: "local" }, target.root);
      expect((await cli(target.root, ["settings", "show"], target.environment)).code).toBe(0);
      expect((await cli(target.root, ["--demo", "profiles"], target.environment)).code).toBe(0);
      for (const [args, extra] of [
        [["--server", "ws://127.0.0.1:1", "profiles"], {}],
        [["--pipe", join(target.root, "missing.sock"), "profiles"], {}],
        [["profiles"], { BAAS_SERVER: "ws://127.0.0.1:1" }],
        [["profiles"], { BAAS_PIPE: join(target.root, "missing-env.sock") }],
      ] as [string[], Record<string, string>][])
        expect((await cli(target.root, args, { ...target.environment, ...extra })).code).toBe(1);
      expect(await target.helperCalls()).toEqual([]);
    }
  );

  test("saved remote mode and legacy custom URLs take precedence over installed runtime metadata", async () => {
    const target = await localFixture({ metadata: true });
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        expect(new URL(request.url).pathname).toBe("/health");
        requests++;
        return Response.json({ identity: "saved-remote" });
      },
    });
    try {
      const url = server.url.toString().replace(/^http/, "ws").replace(/\/$/, "");
      for (const mode of ["remote", undefined] as const) {
        await saveSettings({ url, connectionMode: mode }, target.root);
        const result = await cli(target.root, ["doctor"], target.environment);
        expect(result.code).toBe(0);
        expect(result.data).toMatchObject({ endpoint: url, health: { identity: "saved-remote" } });
      }
      expect(requests).toBe(2);
      expect(await target.helperCalls()).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test.skipIf(process.platform === "win32")(
    "saved remote or legacy pipe remains external even when runtime metadata exists",
    async () => {
      const target = await localFixture({ metadata: true });
      const pipe = join(target.root, "external.sock");
      const backend = Bun.spawn([process.execPath, target.backend, "--pipe-name", pipe], {
        stdout: "ignore",
        stderr: "pipe",
      });
      try {
        const deadline = Date.now() + 2000;
        while (!existsSync(pipe)) {
          if (Date.now() > deadline) throw new Error("external fixture did not listen");
          await Bun.sleep(10);
        }
        for (const mode of ["remote", undefined] as const) {
          await saveSettings(
            { url: "ws://unused.invalid", pipe, connectionMode: mode },
            target.root
          );
          const result = await cli(target.root, ["profiles"], target.environment);
          expect(result.code).toBe(0);
          expect(result.data).toEqual({ "local-id": "本地配置" });
          expect(backend.exitCode).toBeNull();
        }
        expect(await target.helperCalls()).toEqual([]);
      } finally {
        backend.kill();
        await backend.exited;
      }
    }
  );

  test.skipIf(process.platform === "win32")(
    "profile creation prevents confirmation races and never retries malformed acknowledgements",
    async () => {
      const duplicate = await localFixture({ metadata: true, duplicateDuringApproval: "同名档" });
      const refused = await cli(
        duplicate.root,
        ["--yes", "profile", "create", "同名档", "官服"],
        duplicate.environment
      );
      expect(refused.code).toBe(1);
      expect(refused.data.error).toContain("确认期间");
      expect(await duplicate.submitted()).toEqual([]);
      await duplicate.stopped();
      const invalid = await localFixture({ metadata: true, invalidCreatedId: true });
      const failed = await cli(
        invalid.root,
        ["--yes", "profile", "create", "新档", "官服"],
        invalid.environment
      );
      expect(failed.code).toBe(1);
      expect(failed.data.error).toContain("缺少配置档 ID");
      expect((await invalid.submitted()).map((call) => call.command)).toEqual(["add_config"]);
      await invalid.stopped();
    }
  );

  test("demo task wait returns correlated completion with one JSON result", async () => {
    const result = await cli(await directory(), [
      "--demo",
      "--yes",
      "--wait",
      "--follow",
      "run",
      "collect_reward",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.data).toMatchObject({
      accepted: true,
      completed: true,
      succeeded: true,
      profile: "sensei-cn",
      status: { running: false, exit_code: 0 },
    });
    expect(result.data.run_id).toBeTypeOf("string");
    expect(result.data.status.run_id).toBe(result.data.run_id);
    expect(result.data.submission.run_id).toBe(result.data.run_id);
  });

  test("demo scheduler wait times out with exit 124 and never reports success", async () => {
    const result = await cli(await directory(), [
      "--demo",
      "--yes",
      "--wait",
      "--wait-timeout",
      "1",
      "start",
    ]);
    expect(result.code).toBe(124);
    expect(result.data.code).toBe("wait_timeout");
    expect(result.data.error).toContain("等待超时");
    expect(result.data.completed).toBeUndefined();
    expect(result.data.succeeded).toBeUndefined();
  });

  test("dry-run packs preview every validated step without submitting or waiting", async () => {
    const root = await directory();
    const result = await cli(root, ["--demo", "--dry-run", "pack", "daily-wait"]);
    expect(result.code).toBe(0);
    expect(result.data).toMatchObject({ dry_run: true, command: "daily-wait", pack: "baas-core" });
    expect(result.data.steps.map((step: { action: string }) => step.action)).toEqual([
      "scheduler_start",
      "wait_run",
    ]);
    expect(result.data.results).toBeUndefined();
    expect(result.stdout).not.toContain('"accepted":true');
    expect(result.stderr).toBe("");
    expect((await readdir(root)).includes("sessions")).toBe(false);
  });

  test("read-only preflight rejects a mixed pack before any step output", async () => {
    const root = await directory();
    await pack(root, "mixed-plan", [
      { action: "status", args: {} },
      { action: "scheduler_start", args: {} },
    ]);
    const result = await cli(root, ["--demo", "--read-only", "pack", "mixed-plan"]);
    expect(result.code).toBe(1);
    expect(result.data.error).toContain("只读");
    expect(result.data.error).toContain("未执行任何步骤");
    expect(result.data.results).toBeUndefined();
    expect(result.stderr).toBe("");
  });

  test("a later unknown task fails whole-plan preflight before an earlier mutation", async () => {
    const root = await directory();
    await pack(root, "invalid-later-task", [
      { action: "scheduler_start", args: {} },
      { action: "task_run", args: { task: "invented_task" } },
    ]);
    const result = await cli(root, ["--demo", "--yes", "pack", "invalid-later-task"]);
    expect(result.code).toBe(1);
    expect(result.data.error).toContain("任务不存在");
    expect(result.data.error).toContain("未执行任何步骤");
    expect(result.stderr).toBe("");
  });

  test("settings preserve saved preferences independently of environment overrides", async () => {
    const root = await directory();
    await saveSettings(
      { url: "ws://saved.invalid:8190", profile: "saved-profile", language: "zh" },
      root
    );
    const environment = {
      BAAS_SERVER: "ws://environment.invalid:8190",
      BAAS_PROFILE: "environment-profile",
      BAAS_LANG: "ja",
      BAAS_KEY: "must-not-persist",
      BAAS_AI_MODEL: "ignored-model",
      BAAS_AI_API_KEY: "ignored-secret",
    };
    const shown = await cli(root, ["settings", "show"], environment);
    expect(shown.data.saved).toMatchObject({
      url: "ws://saved.invalid:8190",
      profile: "saved-profile",
      language: "zh",
    });
    expect(shown.data.effective).toMatchObject({
      url: "ws://environment.invalid:8190",
      profile: "environment-profile",
      language: "ja",
    });
    expect(shown.data.model).toBeUndefined();
    expect((await cli(root, ["settings", "set", "language", "fr"], environment)).code).toBe(0);
    const disk = await readFile(join(root, "settings.json"), "utf8");
    expect(JSON.parse(disk)).toEqual({
      url: "ws://saved.invalid:8190",
      profile: "saved-profile",
      language: "fr",
    });
    expect(disk).not.toContain("environment");
    expect(disk).not.toContain("must-not-persist");
    expect(disk).not.toContain("ignored-");
    expect((await cli(root, ["settings", "unset", "language"], environment)).code).toBe(0);
    expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual({
      url: "ws://saved.invalid:8190",
      profile: "saved-profile",
    });
  });

  test("removed conversation commands and flags never call a model service", async () => {
    const root = await directory();
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests++;
        return Response.json({ error: "unexpected model request" });
      },
    });
    const environment = {
      BAAS_AI_BASE_URL: server.url.toString(),
      BAAS_AI_MODEL: "unused",
      BAAS_AI_API_KEY: "unused",
    };
    try {
      const ordinary = await cli(root, ["--demo", "profiles"], environment);
      expect(ordinary.code).toBe(0);
      for (const command of [
        "agent",
        "model",
        "models",
        "sessions",
        "resume",
        "new",
        "context",
        "clear",
      ]) {
        const result = await cli(root, ["--demo", command], environment);
        expect(result.code).toBe(1);
        expect(result.data.error).toContain("未知命令");
      }
      for (const args of [
        ["-p", "check"],
        ["--model", "unused"],
        ["--ai-url", server.url.toString()],
        ["--resume", "latest"],
        ["--no-session"],
        ["--instructions", "BAAS.md"],
      ]) {
        const result = await cli(root, args, environment);
        expect(result.code).toBe(1);
        expect(result.data.error).toBeTypeOf("string");
      }
      const helped = await cli(root, ["--help"], environment);
      expect(helped.code).toBe(0);
      expect(helped.data.help).not.toMatch(/agent|model|sessions|resume|BAAS\.md/i);
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("piped text without a BAAS command is rejected without network requests", async () => {
    const root = await directory();
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/index.ts"), "--config-home", root, "--json"],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          BAAS_AI_BASE_URL: "http://127.0.0.1:1/v1",
          BAAS_AI_MODEL: "unused",
          BAAS_LANG: "zh",
        },
      }
    );
    child.stdin.write("帮我执行任务");
    child.stdin.end();
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).error).toContain("请指定 baax 命令");
    expect(await readdir(root)).toEqual([]);
  });

  test("invalid commands, option values and extra positional arguments exit nonzero", async () => {
    const root = await directory();
    for (const args of [
      ["--demo", "unknown-command"],
      ["--demo", "status", "extra"],
      ["--demo", "run"],
      ["--demo", "--yes", "run", "invented-task"],
      ["--wait-timeout", "0", "status"],
      ["--unknown-option", "status"],
      ["settings", "set", "apiKey", "no"],
      ["settings", "show", "extra"],
      ["settings", "set", "language", "unsupported"],
      ["settings", "set", "connectionMode", "unknown"],
    ]) {
      const result = await cli(root, args);
      expect(result.code).toBe(1);
      expect(result.data.error).toBeTypeOf("string");
      expect(result.data.error.length).toBeGreaterThan(0);
    }
  });
});
