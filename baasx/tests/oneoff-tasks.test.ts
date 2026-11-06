import { expect, spyOn, test } from "bun:test";
import { executeAction, type ActionContext } from "../src/actions";
import { DemoClient } from "../src/demo";
import { ONE_OFF_TASKS, isOneOffTask } from "../src/oneoff-tasks";
import { configurationText } from "../src/configuration";

test("desktop one-off tasks use solve without entering the daily scheduler", async () => {
  const client = new DemoClient();
  const request = spyOn(client, "request");
  const before = await client.events("sensei-cn");
  const context: ActionContext = {
    client: async () => client,
    profile: "sensei-cn",
    readOnly: false,
    approve: async () => true,
  };
  try {
    for (const task of ONE_OFF_TASKS) {
      expect(Object.hasOwn(await client.tasks("sensei-cn"), task.id)).toBe(false);
      expect(isOneOffTask(task.id)).toBe(true);
      expect(await executeAction("task_run", { task: task.id }, context)).toMatchObject({
        accepted: true,
        completed: false,
      });
      expect(request).toHaveBeenLastCalledWith("solve", "sensei-cn", { task: task.id });
      expect((await client.status())["sensei-cn"].current_task).toBe(task.id);
      await executeAction("scheduler_stop", {}, context);
      for (const language of ["en", "zh", "ja", "ko", "de", "fr", "ru"])
        expect(configurationText(task.labelKey, language)).not.toBe(task.labelKey);
    }
    expect(await client.events("sensei-cn")).toEqual(before);
    await executeAction("scheduler_start", {}, context);
    expect(request).toHaveBeenLastCalledWith("start_scheduler", "sensei-cn", {});
  } finally {
    request.mockRestore();
    client.close();
  }
});

test("one-off aliases retain approval, read-only, dry-run and concurrency protections", async () => {
  const client = new DemoClient();
  const context: ActionContext = {
    client: async () => client,
    profile: "sensei-cn",
    readOnly: false,
    approve: async () => false,
  };
  const task = { task: "start_normal_task" };
  try {
    await expect(executeAction("task_run", task, context)).rejects.toThrow("取消");
    await expect(
      executeAction("task_run", task, { ...context, readOnly: true }, true)
    ).rejects.toThrow("只读");
    expect(await executeAction("task_run", task, { ...context, dryRun: true })).toMatchObject({
      dry_run: true,
      action: "task_run",
      task: task.task,
    });
    expect((await client.status())["sensei-cn"].running).toBe(false);
    const first = (await executeAction("task_run", task, context, true)) as { run_id: string };
    expect(
      await executeAction("task_run", { task: "start_hard_task" }, context, true)
    ).toMatchObject({ accepted: false, reason: "already-running", run_id: first.run_id });
    for (const name of ["start_unknown", "__proto__", "start_normal_task_extra"])
      await expect(executeAction("task_run", { task: name }, context, true)).rejects.toThrow(
        "不存在"
      );
  } finally {
    client.close();
  }
});
