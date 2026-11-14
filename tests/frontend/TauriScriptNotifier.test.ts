import { describe, expect, test } from "bun:test";
import {
  createStatusSnapshot,
  ScriptNotificationTracker,
  type ScriptStatus,
} from "../../src/components/tauriScriptNotifierState";
import { isReplayedStatus } from "../../src/shared/ScriptStatusEvents";

describe("createStatusSnapshot", () => {
  test("ignores a missing status entry during transport replacement", () => {
    expect(createStatusSnapshot(undefined)).toBeNull();
  });

  test("keeps the previous task while an idle status is rebuilt", () => {
    expect(
      createStatusSnapshot(
        { running: false },
        {
          running: true,
          currentTask: "competition",
          lastTask: "competition",
          exitCode: null,
          runMode: "single",
          runId: "run",
          stopRequested: false,
        }
      )
    ).toMatchObject({ currentTask: null, lastTask: "competition" });
  });
});

const active: ScriptStatus = {
  running: true,
  current_task: "competition",
  run_mode: "scheduler",
  run_id: "run-1",
  timestamp: 100,
  waiting_tasks: [],
};
const done: ScriptStatus = { ...active, current_task: null, exit_code: 0, timestamp: 110 };
const snapshot = (
  tracker: ScriptNotificationTracker,
  statuses: Record<string, ScriptStatus>,
  source = 1
) => tracker.accept({ source, kind: "snapshot", statuses });
const update = (tracker: ScriptNotificationTracker, status: ScriptStatus, source = 1) =>
  tracker.accept({ source, kind: "update", statuses: { a: status } });

describe("new provider events", () => {
  test("startup, reconnect and wake snapshots never replay completed or failed history", () => {
    const tracker = new ScriptNotificationTracker();
    expect(snapshot(tracker, { a: active })).toEqual([]);
    expect(snapshot(tracker, { a: done })).toEqual([]);
    expect(tracker.accept({ source: 2, kind: "reset", statuses: {} })).toEqual([]);
    const history = Object.fromEntries(
      Array.from({ length: 30 }, (_, id) => [
        String(id),
        { ...done, running: false, exit_code: id % 2 },
      ])
    );
    expect(snapshot(tracker, history, 2)).toEqual([]);
    expect(snapshot(tracker, history, 2)).toEqual([]);
  });

  test("unknown idle and placeholder hydration never become completion", () => {
    const tracker = new ScriptNotificationTracker();
    snapshot(tracker, {});
    expect(update(tracker, { running: false })).toEqual([]);
    expect(update(tracker, { running: false, current_task: null, timestamp: 0 })).toEqual([]);
  });

  test("a restarted backend may reuse a run ID without losing genuine new events", () => {
    const tracker = new ScriptNotificationTracker();
    snapshot(tracker, { a: { ...done, running: false } });
    const first = update(tracker, active)[0];
    update(tracker, done);
    tracker.accept({ source: 2, kind: "reset", statuses: {} });
    snapshot(tracker, { a: { ...done, running: false } }, 2);
    const second = update(tracker, active, 2)[0];
    expect(second.kind).toBe("started");
    expect(second.key).not.toBe(first.key);
    expect(second.tag).toBe(first.tag);
    expect(update(tracker, done, 2).map((event) => event.kind)).toEqual(["completed"]);
  });

  test("a genuine scheduler completion is emitted once per execution", () => {
    const tracker = new ScriptNotificationTracker();
    snapshot(tracker, { a: active });
    expect(update(tracker, done).map((event) => event.kind)).toEqual(["completed"]);
    expect(update(tracker, done)).toEqual([]);
    expect(update(tracker, { ...active, timestamp: 120 })).toEqual([]);
    expect(update(tracker, { ...done, timestamp: 130 })).toEqual([]);
    expect(
      update(tracker, { ...active, run_id: "run-2", timestamp: 140 }).map((event) => event.kind)
    ).toEqual(["started"]);
    expect(
      update(tracker, { ...done, run_id: "run-2", timestamp: 150 }).map((event) => event.kind)
    ).toEqual(["completed"]);
  });

  test("live initialization failures notify without first observing running=true", () => {
    const tracker = new ScriptNotificationTracker();
    snapshot(tracker, {});
    expect(
      update(tracker, { running: false, exit_code: 1, timestamp: 120 }).map((event) => event.kind)
    ).toEqual(["failed"]);
    expect(update(tracker, { running: false, exit_code: 1, timestamp: 121 })).toEqual([]);
  });

  test("a worker failure is independent from completion, while user stops are silent", () => {
    const tracker = new ScriptNotificationTracker();
    snapshot(tracker, { a: active });
    expect(
      update(tracker, { ...done, running: false, exit_code: 2 }).map((event) => event.kind)
    ).toEqual(["failed"]);
    const stopped = new ScriptNotificationTracker();
    snapshot(stopped, { a: active });
    expect(
      update(stopped, { ...done, running: false, exit_code: 1, _stopRequested: true })
    ).toEqual([]);
  });

  test("OS replacement tags stay stable across runs, but failure has its own slot", () => {
    const tracker = new ScriptNotificationTracker();
    snapshot(tracker, { a: active });
    const first = update(tracker, done)[0];
    update(tracker, { ...active, run_id: "run-2" });
    const second = update(tracker, { ...done, run_id: "run-2" })[0];
    expect(first.tag).toBe(second.tag);
    expect(first.key).not.toBe(second.key);
    const failure = update(tracker, { ...done, run_id: "run-2", running: false, exit_code: 1 })[0];
    expect(failure.tag).not.toBe(second.tag);
  });

  test("snapshot queue replay is dropped, but two real transitions in one live tick survive", () => {
    expect(isReplayedStatus({ timestamp: 99 }, { timestamp: 100 }, 100)).toBe(true);
    expect(isReplayedStatus({ timestamp: 100 }, { timestamp: 100 }, 100)).toBe(true);
    expect(isReplayedStatus({ timestamp: 110 }, { timestamp: 120 }, 100)).toBe(true);
    expect(isReplayedStatus({ timestamp: 120 }, { timestamp: 120 }, 100)).toBe(false);
    expect(isReplayedStatus({ timestamp: 121 }, { timestamp: 120 }, 100)).toBe(false);
    const tracker = new ScriptNotificationTracker();
    snapshot(tracker, { a: { ...done, running: false, timestamp: 100 } });
    expect(update(tracker, { ...active, timestamp: 120 }).map((event) => event.kind)).toEqual([
      "started",
    ]);
    expect(update(tracker, { ...done, timestamp: 120 }).map((event) => event.kind)).toEqual([
      "completed",
    ]);
  });
});

test("real provider/reset/stop paths preserve notification provenance", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/fixtures/WebsocketStoreNotifications.ts`],
    cwd: `${import.meta.dir}/../..`,
    timeout: 15_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(
    result.exitCode,
    new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)
  ).toBe(0);
});
