import { expect, test } from "bun:test";
import {
  AndroidStartupUpdateCoordinator,
  type AndroidStartupUpdateDependencies,
  type StartupUpdateContext,
} from "../../src/shared/AndroidStartupUpdate";
import {
  runAndroidBackendUpdate,
  type AndroidWorkflowFinished,
} from "../../src/shared/AndroidBackendUpdate";
import type { UpdateResumeState } from "../../src/shared/IdleUpdateState";

const idle = { running: true, current_task: null, waiting_tasks: [], run_mode: "scheduler" };
function fixture() {
  const context: StartupUpdateContext = {
    ready: true,
    enabled: true,
    key: {},
    session: {},
    root: "root",
    ids: ["one"],
    activity: "idle",
  };
  let time = 0;
  let saved: UpdateResumeState | null = null;
  const calls: string[] = [];
  const deps: AndroidStartupUpdateDependencies = {
    context: () => context,
    noUpdate: async () => false,
    check: async () => {
      calls.push("check");
      return { local: "a", remote: "b", updateAvailable: true };
    },
    command: async (name, id) => {
      calls.push(`${name}${id ? `:${id}` : ""}`);
      return { one: idle };
    },
    loadResume: () => saved,
    saveResume: async (value) => {
      calls.push("save");
      saved = value;
    },
    clearResume: async () => {
      calls.push("clear");
      saved = null;
    },
    update: async (beforeRestart) => {
      calls.push("update");
      beforeRestart();
    },
    beginUpdate: () => {
      calls.push("claim");
      return true;
    },
    endUpdate: () => {
      calls.push("release");
    },
    manualActive: () => false,
    publish: () => {},
    now: () => time,
  };
  const controller = new AndroidStartupUpdateCoordinator(deps);
  return {
    context,
    calls,
    deps,
    controller,
    advance: (value = 3_100) => {
      time += value;
    },
    saved: () => saved,
    seed: (value: UpdateResumeState) => {
      saved = value;
    },
  };
}

test("cold startup never checks or replaces source while resources are initializing", async () => {
  const f = fixture();
  f.context.ready = false;
  await f.controller.tick();
  f.advance();
  await f.controller.tick();
  expect(f.calls).toEqual([]);
  expect(f.controller.state.phase).toBe("waiting");
});

test("no update or the disabled auto-update switch releases only a verified startup", async () => {
  for (const kind of ["same", "disabled", "no-update"]) {
    const f = fixture();
    if (kind === "same") f.deps.check = async () => ({ local: "a", remote: "a" });
    if (kind === "disabled") f.context.enabled = false;
    if (kind === "no-update") f.deps.noUpdate = async () => true;
    await f.controller.tick();
    expect(f.controller.state.phase).toBe("ready");
    expect(f.calls).not.toContain("update");
    expect(f.calls).not.toContain("stop_all_tasks");
  }
});

test("updates persist resume state before stopping and wait for a fresh resource-ready cycle", async () => {
  const f = fixture();
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("waiting-idle");
  expect(f.calls).not.toContain("save");
  f.advance();
  await f.controller.tick();
  expect(f.calls.indexOf("save")).toBeLessThan(f.calls.indexOf("stop_all_tasks"));
  expect(f.calls.indexOf("stop_all_tasks")).toBeLessThan(f.calls.indexOf("update"));
  expect(f.controller.state.phase).toBe("restarting");
  expect(f.controller.state.cycle).toBe(1);
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("restarting");
  f.context.ready = false;
  await f.controller.tick();
  f.context.ready = true;
  f.context.key = {};
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("ready");
  expect(f.calls).toContain("start_scheduler:one");
  expect(f.saved()).toBeNull();
});

test("busy tasks, pending queues and single-run sessions cannot authorize an update", async () => {
  for (const status of [
    { ...idle, current_task: "cafe" },
    { ...idle, waiting_tasks: ["cafe"] },
    { ...idle, run_mode: "single" },
    { running: false },
  ]) {
    const f = fixture();
    f.deps.command = async () => ({ one: status });
    await f.controller.tick();
    f.advance();
    await f.controller.tick();
    expect(f.controller.state.phase).toBe("waiting-idle");
    expect(f.calls).not.toContain("save");
    expect(f.calls).not.toContain("update");
  }
});

test("an explicit local fallback leaves a long-running warm backend untouched", async () => {
  const f = fixture();
  f.deps.command = async () => ({ one: { ...idle, current_task: "long task" } });
  await f.controller.tick();
  expect(f.controller.state.canContinueLocal).toBe(true);
  f.controller.useLocal();
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("ready");
  expect(f.calls).not.toContain("stop_all_tasks");
  expect(f.calls).not.toContain("update");
});

test("local fallback accepted during an async status request cannot race into an update", async () => {
  const f = fixture();
  await f.controller.tick();
  f.advance();
  let resolve!: (value: unknown) => void;
  f.deps.command = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = f.controller.tick();
  await Promise.resolve();
  await Promise.resolve();
  f.controller.useLocal();
  resolve({ one: idle });
  await pending;
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("ready");
  expect(f.calls).not.toContain("update");
  expect(f.calls).not.toContain("save");
});

test("a fallback authorized for an old session cannot release a different backend", async () => {
  const f = fixture();
  await f.controller.tick();
  f.context.key = {};
  f.controller.useLocal();
  expect(f.controller.state.phase).toBe("waiting-idle");
});

test("a backend change after accepting local fallback still requires a new startup decision", async () => {
  const f = fixture();
  await f.controller.tick();
  f.controller.useLocal();
  f.context.key = {};
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("waiting");
  expect(f.calls).not.toContain("update");
});

test("foreign active sessions are also protected even if their config snapshot was removed", async () => {
  const f = fixture();
  f.deps.command = async () => ({ foreign: { ...idle, current_task: "battle" } });
  await f.controller.tick();
  f.advance();
  await f.controller.tick();
  expect(f.calls).not.toContain("update");
});

test("manual game control and a failed atomic update claim leave scripts untouched", async () => {
  const f = fixture();
  f.deps.manualActive = () => true;
  await f.controller.tick();
  expect(f.calls).toEqual([]);
  f.deps.manualActive = () => false;
  f.deps.beginUpdate = () => false;
  await f.controller.tick();
  f.advance();
  await f.controller.tick();
  expect(f.calls).not.toContain("stop_all_tasks");
});

test("activity, settings and session changes after async status checks prevent replacement", async () => {
  for (const change of [() => "activity", () => "setting", () => "session"]) {
    const f = fixture();
    await f.controller.tick();
    f.advance();
    f.deps.command = async () => {
      if (change() === "activity") f.context.activity = "new task";
      if (change() === "setting") f.context.enabled = false;
      if (change() === "session") f.context.key = {};
      return { one: idle };
    };
    await f.controller.tick();
    expect(f.calls).not.toContain("update");
    expect(f.calls).not.toContain("save");
  }
});

test("save failures leave the scheduler running and prevent a native workflow", async () => {
  const f = fixture();
  f.deps.saveResume = async () => {
    throw new Error("disk full");
  };
  await f.controller.tick();
  f.advance();
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("failed");
  expect(f.calls).not.toContain("stop_all_tasks");
  expect(f.calls).not.toContain("update");
});

test("an update failure restores previous running states and releases the manual-control lock", async () => {
  const f = fixture();
  f.deps.update = async () => {
    throw new Error("git unavailable");
  };
  await f.controller.tick();
  f.advance();
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("failed");
  expect(f.controller.state.canContinueLocal).toBe(false);
  expect(f.calls).toContain("start_scheduler:one");
  expect(f.calls.at(-1)).toBe("release");
  expect(f.saved()).toBeNull();
});

test("restoration failures retain the durable resume record for retry", async () => {
  const f = fixture();
  f.seed({ schema: 1, root: "root", running: { one: true } });
  f.deps.command = async () => {
    throw new Error("disconnected");
  };
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("failed");
  expect(f.saved()).not.toBeNull();
  expect(f.controller.state.canContinueLocal).toBe(false);
});

test("resume restoration is honored even after auto-update is switched off", async () => {
  const f = fixture();
  f.context.enabled = false;
  f.seed({ schema: 1, root: "root", running: { one: false } });
  await f.controller.tick();
  expect(f.calls).toContain("stop_scheduler:one");
  expect(f.calls).not.toContain("check");
  expect(f.controller.state.phase).toBe("ready");
});

test("offline version checks stay failed until retry or explicit verified-local fallback", async () => {
  const f = fixture();
  f.deps.check = async () => {
    throw new Error("offline");
  };
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("failed");
  expect(f.controller.state.canContinueLocal).toBe(true);
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("failed");
  f.controller.useLocal();
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("ready");
  expect(f.calls).not.toContain("update");
  const retry = fixture();
  retry.deps.check = async () => {
    throw new Error("offline");
  };
  await retry.controller.tick();
  retry.controller.retry();
  retry.deps.check = async () => ({ local: "a", remote: "a" });
  await retry.controller.tick();
  expect(retry.controller.state.phase).toBe("ready");
});

test("unknown remote versions are not reported as up to date", async () => {
  const f = fixture();
  f.deps.check = async () => ({ local: "a", remote: null, updateAvailable: false });
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("failed");
});

test("a restart that never produces fresh resources times out without dropping the resume snapshot", async () => {
  const f = fixture();
  await f.controller.tick();
  f.advance();
  await f.controller.tick();
  f.advance(15 * 60_000 + 1);
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("failed");
  expect(f.saved()).not.toBeNull();
});

test("a failed post-apply restart retries through another fresh bootstrap before restoring", async () => {
  const f = fixture();
  f.deps.update = async (beforeRestart) => {
    beforeRestart();
    throw new Error("restart was not scheduled");
  };
  await f.controller.tick();
  f.advance();
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("failed");
  expect(f.controller.state.cycle).toBe(1);
  expect(f.saved()).not.toBeNull();
  f.controller.retry(true);
  expect(f.controller.state.phase).toBe("restarting");
  expect(f.controller.state.cycle).toBe(2);
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("restarting");
  f.context.ready = false;
  await f.controller.tick();
  f.context.ready = true;
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("ready");
  expect(f.calls).toContain("start_scheduler:one");
  expect(f.saved()).toBeNull();
});

test("a fast verified restart cannot lose the not-ready edge between polling ticks", async () => {
  const f = fixture();
  await f.controller.tick();
  f.advance();
  await f.controller.tick();
  f.controller.observeResourcesReady(false);
  f.context.key = {};
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("ready");
  expect(f.calls).toContain("start_scheduler:one");
});

test("a legitimate ten-minute resource initialization does not expire the coordinator early", async () => {
  const f = fixture();
  await f.controller.tick();
  f.advance();
  await f.controller.tick();
  f.context.ready = false;
  f.advance(10 * 60_000);
  await f.controller.tick();
  expect(f.controller.state.phase).toBe("restarting");
});

test("concurrent polling does not start duplicate checks or workflows", async () => {
  const f = fixture();
  let resolve!: (value: { local: string; remote: string }) => void;
  f.deps.check = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = f.controller.tick();
  await Promise.resolve();
  await Promise.resolve();
  await f.controller.tick();
  resolve({ local: "a", remote: "a" });
  await pending;
  expect(f.controller.state.phase).toBe("ready");
});

function nativeFixture() {
  let handler: (event: { payload: AndroidWorkflowFinished }) => void = () => {};
  const calls: string[] = [];
  let stopped = false;
  const invoke = async <T>(command: string): Promise<T> => {
    calls.push(command);
    if (command === "updater_start_workflow") return { sessionId: "owned" } as T;
    return { restartScheduled: true } as T;
  };
  return {
    calls,
    invoke,
    listen: async (_event: string, callback: typeof handler) => {
      handler = callback;
      return () => {
        stopped = true;
      };
    },
    emit: (payload: AndroidWorkflowFinished) => handler({ payload }),
    stopped: () => stopped,
  };
}

test("native workflow completion must match the returned session id", async () => {
  const f = nativeFixture();
  let restart = false;
  const pending = runAndroidBackendUpdate({
    ...f,
    beforeRestart: () => {
      restart = true;
    },
    timeoutMs: 100,
  });
  await Promise.resolve();
  await Promise.resolve();
  f.emit({ sessionId: "foreign", success: true });
  await Promise.resolve();
  expect(restart).toBe(false);
  f.emit({ sessionId: "owned", success: true });
  await pending;
  expect(restart).toBe(true);
  expect(f.calls).toEqual(["updater_start_workflow", "updater_restart_backend"]);
  expect(f.stopped()).toBe(true);
});

test("early completion is buffered until the workflow response supplies its identity", async () => {
  const f = nativeFixture();
  const invoke = async <T>(name: string): Promise<T> => {
    if (name === "updater_start_workflow") f.emit({ sessionId: "owned", success: true });
    return f.invoke<T>(name);
  };
  await runAndroidBackendUpdate({ ...f, invoke, beforeRestart: () => {}, timeoutMs: 50 });
  expect(f.calls).toContain("updater_restart_backend");
});

test("failed or timed-out workflows abort without restarting the backend", async () => {
  for (const failure of [true, false]) {
    const f = nativeFixture();
    const pending = runAndroidBackendUpdate({ ...f, beforeRestart: () => {}, timeoutMs: 5 });
    await Promise.resolve();
    await Promise.resolve();
    if (failure) f.emit({ sessionId: "owned", success: false });
    await expect(pending).rejects.toThrow("failed or timed out");
    expect(f.calls).toEqual(["updater_start_workflow", "updater_abort_workflow"]);
    expect(f.stopped()).toBe(true);
  }
});

test("an unscheduled restart is a failure, not an update success", async () => {
  const f = nativeFixture();
  const invoke = async <T>(name: string): Promise<T> =>
    name === "updater_restart_backend" ? ({ restartScheduled: false } as T) : f.invoke<T>(name);
  const pending = runAndroidBackendUpdate({ ...f, invoke, beforeRestart: () => {}, timeoutMs: 50 });
  await Promise.resolve();
  await Promise.resolve();
  f.emit({ sessionId: "owned", success: true });
  await expect(pending).rejects.toThrow("not scheduled");
  expect(f.stopped()).toBe(true);
});
