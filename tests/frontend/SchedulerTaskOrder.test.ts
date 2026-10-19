import { describe, expect, test } from "bun:test";
import { sortSchedulerTasks } from "../../src/shared/SchedulerTaskOrder";
import type { EventConfig } from "../../src/types/event";

const task = (name: string, extra: Partial<EventConfig> = {}): EventConfig => ({
  func_name: name,
  event_name: name,
  enabled: true,
  priority: 1,
  interval: 60,
  next_tick: 1700000000,
  daily_reset: [],
  disabled_time_range: [],
  pre_task: [],
  post_task: [],
  ...extra,
});

describe("Scheduler task order", () => {
  test("default sorting keeps enabled tasks first and sorts priority within each group", () => {
    const tasks = [
      task("disabled-high", { enabled: false, priority: 0 }),
      task("enabled-low", { priority: 10 }),
      task("disabled-low", { enabled: false, priority: 5 }),
      task("enabled-high", { priority: 2 }),
    ];

    expect(sortSchedulerTasks(tasks, "default").map((item) => item.func_name)).toEqual([
      "enabled-high",
      "enabled-low",
      "disabled-high",
      "disabled-low",
    ]);
  });

  test("time sorting keeps overdue disabled tasks after enabled tasks", () => {
    const tasks = [
      task("disabled-early", { enabled: false, next_tick: 100 }),
      task("enabled-late", { next_tick: 300.5 }),
      task("disabled-late", { enabled: false, next_tick: 200.25 }),
      task("enabled-early", { next_tick: 300.125 }),
    ];

    expect(sortSchedulerTasks(tasks, "time").map((item) => item.func_name)).toEqual([
      "enabled-early",
      "enabled-late",
      "disabled-early",
      "disabled-late",
    ]);
  });

  test("ties preserve original order and sorting never mutates the source or task objects", () => {
    const tasks = Object.freeze([
      Object.freeze(task("disabled-first", { enabled: false })),
      Object.freeze(task("enabled-first")),
      Object.freeze(task("disabled-second", { enabled: false })),
      Object.freeze(task("enabled-second")),
    ]);
    const before = JSON.stringify(tasks);

    for (const mode of ["default", "time"] as const) {
      const sorted = sortSchedulerTasks(tasks, mode);
      expect(sorted).not.toBe(tasks);
      expect(sorted.map((item) => item.func_name)).toEqual([
        "enabled-first",
        "enabled-second",
        "disabled-first",
        "disabled-second",
      ]);
      expect(sorted[0]).toBe(tasks[1]);
      expect(sorted[2]).toBe(tasks[0]);
      expect(JSON.stringify(tasks)).toBe(before);
    }
  });
});
