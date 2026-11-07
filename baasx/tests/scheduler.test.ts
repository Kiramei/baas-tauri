import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../src/workspace";
import { DemoClient } from "../src/demo";
import {
  parseSchedulerField,
  validateSchedulerChanges,
  schedulerTasks,
  schedulerSummary,
  formatSchedulerField,
  SCHEDULER_FIELDS,
} from "../src/scheduler";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function workspace(options: Parameters<typeof Workspace.create>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baas-scheduler-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const instance = await Workspace.create({ demo: true, directory, ...options });
  cleanup.push(() => instance.close());
  await instance.connect();
  await instance.loadScheduler();
  return instance;
}
function client(workspace: Workspace) {
  return (workspace as unknown as { client: DemoClient }).client;
}
async function approval(workspace: Workspace) {
  const deadline = Date.now() + 2000;
  while (!workspace.snapshot.prompt) {
    if (Date.now() > deadline) throw new Error("approval did not arrive");
    await Bun.sleep(5);
  }
}
const tasks = schedulerTasks([
  { func_name: "one", event_name: "One" },
  { func_name: "two", event_name: "Two" },
  { func_name: "three", event_name: "Three" },
]);
describe("desktop scheduler field model", () => {
  test("exposes all editable Desktop fields with time and ordered relationship parsers", () => {
    expect(SCHEDULER_FIELDS.map((field) => field.key)).toEqual([
      "enabled",
      "next_tick",
      "priority",
      "interval",
      "daily_reset",
      "disabled_time_range",
      "pre_task",
      "post_task",
    ]);
    expect(parseSchedulerField("daily_reset", "04:00, 16:30:10")).toEqual([
      [4, 0, 0],
      [16, 30, 10],
    ]);
    expect(parseSchedulerField("disabled_time_range", "12:00-13:30")).toEqual([
      [
        [12, 0, 0],
        [13, 30, 0],
      ],
    ]);
    expect(parseSchedulerField("pre_task", "three,two")).toEqual(["three", "two"]);
    expect(parseSchedulerField("next_tick", "2026-10-29T08:00:00Z")).toBe(
      Date.parse("2026-10-29T08:00:00Z") / 1000
    );
    expect(formatSchedulerField("daily_reset", [[4, 0, 0]])).toBe("04:00:00");
    const localDate = new Date(2026, 9, 29, 13, 14, 15).getTime() / 1000;
    expect(formatSchedulerField("next_tick", localDate)).toBe("2026-10-29 13:14:15");
    expect(parseSchedulerField("next_tick", formatSchedulerField("next_tick", localDate))).toBe(
      localDate
    );
    expect(parseSchedulerField("next_tick", formatSchedulerField("next_tick", 0))).toBe(0);
    expect(() => parseSchedulerField("next_tick", "2026-02-30 12:30:00")).toThrow();
    expect(
      validateSchedulerChanges(
        "one",
        {
          priority: -2,
          interval: 0,
          enabled: false,
          daily_reset: [[23, 59, 59]],
          disabled_time_range: [
            [
              [0, 0, 0],
              [3, 59, 59],
            ],
          ],
          pre_task: ["three", "two"],
        },
        tasks
      )
    ).toMatchObject({ priority: -2, pre_task: ["three", "two"] });
  });
  test("rejects malformed numbers, times, overnight ranges and unsafe relationships", () => {
    for (const fields of [
      { enabled: 1 },
      { interval: -1 },
      { priority: 1.5 },
      { next_tick: NaN },
      { daily_reset: [[24, 0, 0]] },
      {
        disabled_time_range: [
          [
            [23, 0, 0],
            [2, 0, 0],
          ],
        ],
      },
      { pre_task: ["one"] },
      { post_task: ["missing"] },
      { pre_task: ["two", "two"] },
      { func_name: "renamed" },
    ])
      expect(() => validateSchedulerChanges("one", fields, tasks)).toThrow();
    expect(() => parseSchedulerField("interval", " ")).toThrow();
    expect(() => parseSchedulerField("daily_reset", "99:00")).toThrow();
    expect(() => parseSchedulerField("next_tick", "invalid")).toThrow();
  });
  test("effective scheduling follows priority and local disabled periods rather than oldest due time", () => {
    const now = new Date(2026, 9, 29, 12, 30, 0).getTime() / 1000;
    const scheduled = schedulerTasks([
      { func_name: "old", enabled: true, next_tick: now - 300, priority: 20 },
      { func_name: "urgent", enabled: true, next_tick: now - 10, priority: -1 },
      {
        func_name: "blocked",
        enabled: true,
        next_tick: now - 999,
        priority: -100,
        disabled_time_range: [
          [
            [12, 0, 0],
            [13, 0, 0],
          ],
        ],
      },
      { func_name: "off", enabled: false, next_tick: 0, priority: -200 },
    ]);
    const summary = schedulerSummary(
      { profile: "main", tasks: scheduled, newEventState: "default" },
      {},
      now
    );
    expect(summary).toMatchObject({
      nextTask: "urgent",
      due: 2,
      blocked: 1,
      queue: ["urgent", "old"],
    });
    expect(summary.nextTick).toBe(now - 10);
    scheduled[0].enabled = false;
    scheduled[1].enabled = false;
    const blocked = schedulerSummary(
      { profile: "main", tasks: scheduled, newEventState: "default" },
      {},
      now
    );
    expect(blocked.nextTask).toBe("blocked");
    expect(blocked.nextTick).toBe(new Date(2026, 9, 29, 13, 0, 1).getTime() / 1000);
    expect(blocked.due).toBe(0);
    scheduled[2].disabled_time_range = [
      [
        [0, 0, 0],
        [23, 59, 59],
      ],
    ];
    expect(
      schedulerSummary({ profile: "main", tasks: scheduled, newEventState: "default" }, {}, now)
        .nextTask
    ).toBeUndefined();
  });
});
describe("scheduler controller editing", () => {
  test("loads real event shapes and saves fields, bulk enabled state and reset times", async () => {
    const instance = await workspace({ yes: true });
    expect(instance.snapshot.scheduler?.tasks[0]).toMatchObject({
      func_name: "collect_reward",
      priority: 0,
      interval: 86400,
      daily_reset: [[4, 0, 0]],
    });
    expect(
      await instance.saveScheduler("cafe", {
        enabled: false,
        priority: -1,
        interval: 3600,
        pre_task: ["collect_reward"],
        post_task: ["mail"],
      })
    ).toBe(true);
    expect(
      (await client(instance).events("sensei-cn")).find((task) => task.func_name === "cafe")
    ).toMatchObject({ enabled: false, priority: -1, interval: 3600, pre_task: ["collect_reward"] });
    await instance.setAllSchedulerEnabled(false);
    expect(instance.snapshot.scheduler?.tasks.every((task) => !task.enabled)).toBe(true);
    await instance.setAllSchedulerEnabled(true);
    expect(instance.snapshot.scheduler?.tasks.every((task) => task.enabled)).toBe(true);
    const before = Math.floor(Date.now() / 1000);
    await instance.resetSchedulerTimes();
    expect(instance.snapshot.scheduler?.tasks.every((task) => task.next_tick >= before)).toBe(true);
    await instance.setNewEventState("off");
    expect(instance.snapshot.scheduler?.newEventState).toBe("off");
    await instance.selectProfile("sensei-jp");
    expect(instance.snapshot.scheduler?.profile).toBe("sensei-jp");
    expect(
      instance.snapshot.scheduler?.tasks.find((task) => task.func_name === "cafe")?.priority
    ).toBe(10);
  });
  test("confirmation denial, read-only and dry-run never mutate events or config", async () => {
    const instance = await workspace();
    const before = await client(instance).events("sensei-cn");
    const pending = instance.saveScheduler("cafe", { enabled: false });
    await approval(instance);
    instance.answerPrompt(false);
    expect(await pending).toBe(false);
    expect(await client(instance).events("sensei-cn")).toEqual(before);
    const readonly = await workspace({ yes: true, readOnly: true });
    expect(await readonly.saveScheduler("cafe", { enabled: false })).toBe(false);
    expect(readonly.snapshot.activity.at(-1)?.detail).toContain("只读");
    expect(readonly.snapshot.prompt).toBeUndefined();
    const preview = await workspace({ dryRun: true });
    expect(await preview.setAllSchedulerEnabled(false)).toBe(true);
    expect(await preview.setNewEventState("off")).toBe(true);
    expect(preview.snapshot.prompt).toBeUndefined();
    expect((await client(preview).events("sensei-cn")).every((task) => task.enabled)).toBe(true);
    expect((await client(preview).config("sensei-cn")).new_event_enable_state).toBe("default");
  });
  test("a field changed during approval produces a conflict while unrelated fields remain intact", async () => {
    const instance = await workspace();
    const pending = instance.saveScheduler("cafe", { interval: 100 });
    await approval(instance);
    await client(instance).patchEvents("sensei-cn", [
      { func_name: "cafe", fields: { interval: 999, priority: 99 } },
    ]);
    instance.answerPrompt(true);
    expect(await pending).toBe(false);
    expect(
      (await client(instance).events("sensei-cn")).find((task) => task.func_name === "cafe")
    ).toMatchObject({ interval: 999, priority: 99 });
    expect(instance.snapshot.activity.at(-1)?.detail).toContain("确认期间");
  });
  test("new-event default cancellation returns false without reporting a save", async () => {
    const instance = await workspace();
    const pending = instance.setNewEventState("off");
    await approval(instance);
    instance.answerPrompt(false);
    expect(await pending).toBe(false);
    expect((await client(instance).config("sensei-cn")).new_event_enable_state).toBe("default");
    expect(instance.snapshot.activity.at(-1)?.title).not.toContain("已保存");
    expect(await instance.saveScheduler("cafe", { priority: 10 })).toBe(true);
  });
  test("snapshots do not expose mutable scheduler state and summary gives actual counts", async () => {
    const instance = await workspace({ yes: true });
    const copy = instance.snapshot.scheduler!;
    copy.tasks[0].enabled = false;
    expect(instance.snapshot.scheduler?.tasks[0].enabled).toBe(true);
    const summary = schedulerSummary(instance.snapshot.scheduler!, {
      current_task: "mail",
      waiting_tasks: ["cafe"],
    });
    expect(summary).toMatchObject({
      total: 3,
      enabled: 3,
      currentTask: "mail",
      waitingTasks: ["cafe"],
    });
  });
});
