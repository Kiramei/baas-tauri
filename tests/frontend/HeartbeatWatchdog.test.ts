import { describe, expect, test } from "bun:test";
import { HeartbeatWatchdog } from "../../src/shared/HeartbeatWatchdog";

describe("heartbeat recovery grace", () => {
  test("a same-mode switch and zero heartbeat grant a fresh grace period", () => {
    const watchdog = new HeartbeatWatchdog(0);
    watchdog.update("websocket", "authenticated", 100, 0);
    expect(watchdog.shouldRecover(6000)).toBe(true);
    watchdog.update("websocket", "control_connecting", 0, 6000);
    expect(watchdog.shouldRecover(60_000)).toBe(false);
    watchdog.update("websocket", "authenticated", 0, 60_000);
    expect(watchdog.shouldRecover(65_000)).toBe(false);
    expect(watchdog.shouldRecover(65_001)).toBe(true);
  });
  test("polling does not extend grace, while a new heartbeat does", () => {
    const watchdog = new HeartbeatWatchdog(0);
    watchdog.update("websocket", "authenticated", 100, 0);
    watchdog.update("websocket", "authenticated", 100, 4000);
    expect(watchdog.shouldRecover(5001)).toBe(true);
    watchdog.update("websocket", "authenticated", 200, 5001);
    expect(watchdog.shouldRecover(10_001)).toBe(false);
    expect(watchdog.shouldRecover(10_002)).toBe(true);
  });
  test("native modes and unauthenticated phases never trigger heartbeat restarts", () => {
    const watchdog = new HeartbeatWatchdog(0);
    for (const mode of ["pipe", "shm"] as const) {
      watchdog.update(mode, "authenticated", 0, 0);
      expect(watchdog.shouldRecover(100_000)).toBe(false);
    }
    for (const phase of ["idle", "control_connecting", "resuming", "waiting_password", "revoked"]) {
      watchdog.update("websocket", phase, 0, 0);
      expect(watchdog.shouldRecover(100_000)).toBe(false);
    }
  });
});
