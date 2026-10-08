import { describe, expect, test } from "bun:test";
import {
  allProfilesIdle,
  captureUpdateResumeState,
  restoreUpdateResumeState,
  performIdleUpdate,
} from "../../src/shared/IdleUpdateState";

const idle = { running: true, current_task: null, waiting_tasks: [], run_mode: "scheduler" };

describe("idle backend update", () => {
  const transaction = (calls: string[], fail?: string) =>
    Object.fromEntries(
      ["save", "stop", "update", "restore", "clear"].map((step) => [
        step,
        async () => {
          calls.push(step);
          if (step === fail) throw new Error(step);
        },
      ])
    ) as Parameters<typeof performIdleUpdate>[0];

  test("saves before stopping and keeps the snapshot through a successful update", async () => {
    const calls: string[] = [];
    await performIdleUpdate(transaction(calls));
    expect(calls).toEqual(["save", "stop", "update"]);
  });

  test("failed persistence leaves the running scripts untouched", async () => {
    const calls: string[] = [];
    await expect(performIdleUpdate(transaction(calls, "save"))).rejects.toThrow("save");
    expect(calls).toEqual(["save"]);
  });

  test("failed update restores scripts before clearing the snapshot", async () => {
    const calls: string[] = [];
    await expect(performIdleUpdate(transaction(calls, "update"))).rejects.toThrow("update");
    expect(calls).toEqual(["save", "stop", "update", "restore", "clear"]);
  });

  test("failed restore preserves the snapshot for the next startup", async () => {
    const calls: string[] = [];
    const steps = transaction(calls, "restore");
    steps.update = async () => {
      throw new Error("update");
    };
    await expect(performIdleUpdate(steps)).rejects.toThrow("restore");
    expect(calls).toEqual(["save", "stop", "restore"]);
  });

  test("running and stopped configurations can both be idle", () => {
    expect(allProfilesIdle(["a", "b"], { a: idle, b: { ...idle, running: false } })).toBe(true);
    expect(allProfilesIdle(["a"], { a: { ...idle, current_task: "cafe" } })).toBe(false);
    expect(allProfilesIdle(["a"], { a: { ...idle, waiting_tasks: ["cafe"] } })).toBe(false);
    expect(allProfilesIdle(["a"], { a: { ...idle, run_mode: "single" } })).toBe(false);
  });

  test("empty and incomplete snapshots cannot authorize an update", () => {
    expect(allProfilesIdle([], {})).toBe(false);
    expect(allProfilesIdle(["a", "b"], { a: idle })).toBe(false);
    expect(allProfilesIdle(["a"], { a: { running: false } })).toBe(false);
  });

  test("restores only saved profiles and keeps stopped profiles stopped", async () => {
    const saved = captureUpdateResumeState("D:/BAAS", ["a", "b", "removed"], {
      a: idle,
      b: { ...idle, running: false },
      removed: idle,
    });
    const calls: string[] = [];
    await restoreUpdateResumeState(saved, ["a", "b", "new"], async (name, id) => {
      calls.push(`${name}:${id}`);
    });
    expect(calls).toEqual(["start_scheduler:a", "stop_scheduler:b"]);
    expect(saved.running).toEqual({ a: true, b: false, removed: true });
  });

  test("a restore command failure is propagated so the saved state can be retried", async () => {
    const saved = captureUpdateResumeState("D:/BAAS", ["a"], { a: idle });
    await expect(
      restoreUpdateResumeState(saved, ["a"], async () => {
        throw new Error("disconnected");
      })
    ).rejects.toThrow("disconnected");
    expect(saved.running.a).toBe(true);
  });
});
