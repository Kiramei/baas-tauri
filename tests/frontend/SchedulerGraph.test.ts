import { describe, expect, test } from "bun:test";
import {
  arrangeTasks,
  connectionError,
  graphStorageKey,
  relationPatch,
  relationsFor,
  taskFieldPatch,
  validPositions,
} from "../../src/features/schedulerGraph";
import type { EventConfig } from "../../src/types/event";

const task = (name: string, extra: Partial<EventConfig> = {}): EventConfig => ({
  func_name: name,
  event_name: name,
  enabled: true,
  priority: 1,
  interval: 60,
  next_tick: 1700000000.125,
  daily_reset: [],
  disabled_time_range: [],
  pre_task: [],
  post_task: [],
  ...extra,
});

describe("Scheduler workflow", () => {
  test("pre/post edges have independent owners even when they connect the same nodes", () => {
    const tasks = [task("a", { post_task: ["b"] }), task("b", { pre_task: ["a"] })];
    const graph = relationsFor(tasks);
    expect(graph.relations).toHaveLength(2);
    expect(graph.cyclic).toBe(false);
    expect(relationPatch(tasks, { kind: "pre", owner: "b", related: "a" }, true)).toEqual({
      "1/pre_task": [],
    });
    expect(relationPatch(tasks, { kind: "post", owner: "a", related: "b" }, true)).toEqual({
      "0/post_task": [],
    });
    expect(tasks[0].post_task).toEqual(["b"]);
  });
  test("validates connections across both dependency kinds", () => {
    const tasks = [task("a", { post_task: ["b"] }), task("b"), task("c", { pre_task: ["b"] })];
    expect(connectionError(tasks, "c", "a", "pre", "pre")).toBe("cycle");
    expect(connectionError(tasks, "a", "a", "pre", "pre")).toBe("selfLink");
    expect(connectionError(tasks, "a", "b", "post", "post")).toBe("duplicate");
    expect(connectionError(tasks, "a", "b", "pre", "post")).toBe("portMismatch");
    expect(connectionError(tasks, "missing", "b", "pre", "pre")).toBe("unknown");
    expect(connectionError(tasks, "a", "b", "pre", "pre")).toBeNull();
  });
  test("preserves legacy cycles, missing references, task fields and fractional timestamps", () => {
    const tasks = [task("a", { pre_task: ["b", "missing"] }), task("b", { pre_task: ["a"] })];
    const before = JSON.stringify(tasks);
    expect(relationsFor(tasks).cyclic).toBe(true);
    expect(relationsFor(tasks).unknown).toEqual(["a → missing"]);
    expect(taskFieldPatch(tasks, "a", { enabled: false })).toEqual({ "0/enabled": false });
    expect(relationPatch(tasks, { kind: "pre", owner: "a", related: "b" }, true)).toEqual({
      "0/pre_task": ["missing"],
    });
    expect(
      Object.values(arrangeTasks(tasks)).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    ).toBe(true);
    expect(JSON.stringify(tasks)).toBe(before);
  });
  test("uses current task index and ignores no-op changes", () => {
    const tasks = [task("b"), task("a")];
    expect(taskFieldPatch(tasks, "a", { next_tick: 2000 })).toEqual({ "1/next_tick": 2000 });
    expect(taskFieldPatch(tasks, "a", { enabled: true })).toEqual({});
    expect(taskFieldPatch(tasks, "missing", { enabled: false })).toEqual({});
  });
  test("layout is deterministic, separates nodes and flows left to right", () => {
    const tasks = [
      task("a", { post_task: ["b", "c"] }),
      task("b"),
      task("c"),
      ...Array.from({ length: 30 }, (_, i) => task(`solo${i}`)),
    ];
    const positions = arrangeTasks(tasks);
    expect(positions).toEqual(arrangeTasks(tasks));
    expect(positions.a.x).toBeLessThan(positions.b.x);
    const points = Object.values(positions);
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++)
        expect(
          Math.abs(points[i].x - points[j].x) >= 278 || Math.abs(points[i].y - points[j].y) >= 300
        ).toBe(true);
  });
  test("layout persistence is isolated by backend and account and rejects corrupt coordinates", () => {
    expect(graphStorageKey("a", "one")).not.toBe(graphStorageKey("a", "two"));
    expect(graphStorageKey("a", "one")).not.toBe(graphStorageKey("b", "one"));
    expect(validPositions({ a: { x: 5, y: 10 }, b: { x: Infinity, y: 1 }, c: null })).toEqual({
      a: { x: 5, y: 10 },
    });
    expect(validPositions(null)).toEqual({});
  });
});
