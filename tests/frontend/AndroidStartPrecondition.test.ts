import { describe, expect, test } from "bun:test";
import {
  getAndroidStartAccess,
  runAndroidStartAction,
  type AndroidShizukuStatus,
} from "../../src/shared/AndroidStartPrecondition";

const ready: AndroidShizukuStatus = {
  shizukuInstalled: true,
  shizukuRunning: true,
  shizukuGranted: true,
};

describe("Android startup access", () => {
  test("installation and live service take precedence over an old grant", () => {
    expect(getAndroidStartAccess({ ...ready, shizukuInstalled: false })).toBe("missing");
    expect(getAndroidStartAccess({ ...ready, shizukuRunning: false })).toBe("stopped");
    expect(getAndroidStartAccess({ ...ready, shizukuGranted: false })).toBe("permission");
    expect(getAndroidStartAccess(ready)).toBe("ready");
  });

  test.each([
    ["missing", { ...ready, shizukuInstalled: false }],
    ["stopped", { ...ready, shizukuRunning: false }],
    ["permission", { ...ready, shizukuGranted: false }],
  ] as const)("%s prevents display preparation and scheduler dispatch", async (blocked, status) => {
    const calls: string[] = [];
    const allowed = await runAndroidStartAction({
      readStatus: async () => {
        calls.push("status");
        return status;
      },
      onBlocked: (state) => {
        calls.push(state);
      },
      action: async () => {
        calls.push("prepare", "start_scheduler");
      },
    });
    expect(allowed).toBe(false);
    expect(calls).toEqual(["status", blocked]);
  });

  test("a ready service permits startup, but every subsequent start reads a fresh status", async () => {
    const calls: string[] = [];
    let status = ready;
    const request = {
      readStatus: async () => {
        calls.push("status");
        return status;
      },
      onBlocked: (state: string) => {
        calls.push(state);
      },
      action: async () => {
        calls.push("prepare", "start_scheduler");
      },
    };
    expect(await runAndroidStartAction(request)).toBe(true);
    status = { ...ready, shizukuRunning: false };
    expect(await runAndroidStartAction(request)).toBe(false);
    expect(calls).toEqual(["status", "prepare", "start_scheduler", "status", "stopped"]);
  });

  test("status errors fail closed before preparing or dispatching", async () => {
    let started = false;
    await expect(
      runAndroidStartAction({
        readStatus: async () => {
          throw new Error("binder unavailable");
        },
        onBlocked: () => {},
        action: () => {
          started = true;
        },
      })
    ).rejects.toThrow("binder unavailable");
    expect(started).toBe(false);
  });

  test("cleanup does not require an installed or running service", async () => {
    const calls: string[] = [];
    expect(
      await runAndroidStartAction({
        operation: "stop",
        readStatus: async () => {
          throw new Error("must not check Shizuku for stop");
        },
        onBlocked: () => {
          calls.push("blocked");
        },
        action: async () => {
          calls.push("stop_scheduler", "cleanup");
        },
      })
    ).toBe(true);
    expect(calls).toEqual(["stop_scheduler", "cleanup"]);
  });

  test("a failed display preparation is reported as unsuccessful", async () => {
    expect(
      await runAndroidStartAction({
        readStatus: async () => ready,
        onBlocked: () => {},
        action: async () => false,
      })
    ).toBe(false);
  });
});
