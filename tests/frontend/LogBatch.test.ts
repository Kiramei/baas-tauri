import { describe, expect, test } from "bun:test";
import { appendLogGroups, createLogBatch, groupLogEntries } from "../../src/store/LogBatch";
import { useGlobalLogStore } from "../../src/store/GlobalLogStore";

const row = (message: string, scope = "global") => ({
  time: "2026-10-15T12:00:00+00:00", level: "INFO", message, scope,
});

function scheduler() {
  const jobs = new Map<object, () => void>();
  return {
    jobs,
    schedule(callback: () => void) {
      const handle = {};
      jobs.set(handle, callback);
      return handle;
    },
    cancel(handle: unknown) { jobs.delete(handle as object); },
    tick() { for (const callback of [...jobs.values()]) callback(); },
  };
}

describe("provider log batching", () => {
  test("publishes a burst once, preserving mixed-scope order and every row", () => {
    const clock = scheduler();
    const batches: any[][] = [];
    const batch = createLogBatch((entries) => batches.push(entries), clock);
    const entries = [row("a"), row("b", "config:1"), row("c")];
    entries.forEach(batch.push);
    expect(clock.jobs.size).toBe(1);
    expect(batches).toHaveLength(0);
    clock.tick();
    expect(batches).toEqual([entries]);
    expect(clock.jobs.size).toBe(0);
    batch.flush();
    expect(batches).toHaveLength(1);
  });

  test("bounds pending work and flushes the remainder on connection close", () => {
    const clock = scheduler();
    const batches: any[][] = [];
    const batch = createLogBatch((entries) => batches.push(entries), { ...clock, maxEntries: 3 });
    const entries = Array.from({ length: 8 }, (_, index) => row(String(index)));
    entries.forEach(batch.push);
    expect(batches.map((entries) => entries.length)).toEqual([3, 3]);
    batch.flush();
    expect(batches.flat()).toEqual(entries);
    expect(clock.jobs.size).toBe(0);
  });

  test("discarding buffered rows cancels the timer before replacing a snapshot", () => {
    const clock = scheduler();
    const batches: any[][] = [];
    const batch = createLogBatch((entries) => batches.push(entries), clock);
    batch.push(row("old"));
    batch.clear();
    clock.tick();
    expect(batches).toEqual([]);
    batch.push(row("new"));
    clock.tick();
    expect(batches).toEqual([[row("new")]]);
  });

  test("groups snapshots and only replaces arrays for scopes with new rows", () => {
    const current = { global: [row("existing")], untouched: [row("keep")] };
    const groups = groupLogEntries([row("a"), row("b", "config:1"), row("c")]);
    const next = appendLogGroups(current, groups);
    expect(next.global.map((entry) => entry.message)).toEqual(["existing", "a", "c"]);
    expect(next["config:1"].map((entry) => entry.message)).toEqual(["b"]);
    expect(next.untouched).toBe(current.untouched);
    expect(current.global).toHaveLength(1);
    expect(groups.global[0]).not.toHaveProperty("scope");
  });

  test("replays global history with a single store notification", () => {
    useGlobalLogStore.setState({ globalLogData: [] });
    let notifications = 0;
    const unsubscribe = useGlobalLogStore.subscribe(() => { notifications += 1; });
    const entries = Array.from({ length: 1_000 }, (_, index) => row(String(index)));
    useGlobalLogStore.getState().appendGlobalLogs(entries);
    useGlobalLogStore.getState().appendGlobalLogs([]);
    unsubscribe();
    expect(notifications).toBe(1);
    expect(useGlobalLogStore.getState().globalLogData).toEqual(entries);
    useGlobalLogStore.setState({ globalLogData: [] });
  });
});
