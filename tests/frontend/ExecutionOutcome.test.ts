import { describe, expect, test } from "bun:test";
import { getExecutionOutcome, mergeExecutionStatus } from "../../src/shared/ExecutionOutcome";

describe("execution outcomes", () => {
  test("requires an explicit exit failure, never a historical log or idle marker", () => {
    for (const status of [undefined, {}, { running: false }, { exit_code: 0 }, { exit_code: "0" }, { exit_code: null }]) {
      expect(getExecutionOutcome(status)).toBe("idle");
    }
    expect(getExecutionOutcome({ running: false, exit_code: 1 })).toBe("failed");
    expect(getExecutionOutcome({ exit_code: "worker-crashed" })).toBe("failed");
    expect(getExecutionOutcome({ running: true, exit_code: 1 })).toBe("running");
  });

  test("a new run clears the previous failure even if an old backend carries its exit marker", () => {
    const failed = { running: false, exit_code: 1, run_id: "old", _stopRequested: true };
    const running = mergeExecutionStatus(failed, { running: true, run_id: "new", exit_code: 1 });
    expect(running).toMatchObject({ exit_code: null, _stopRequested: false });
    expect(getExecutionOutcome(running)).toBe("running");
    expect(getExecutionOutcome(mergeExecutionStatus(running, { running: false }))).toBe("idle");
  });

  test("failure persists across partial updates until a new execution or success", () => {
    const failed = { running: false, exit_code: 2, run_id: "old" };
    expect(getExecutionOutcome(mergeExecutionStatus(failed, {}))).toBe("failed");
    expect(getExecutionOutcome(mergeExecutionStatus(failed, { exit_code: 0 }))).toBe("idle");
  });

  test("a deliberate stop is idle even when the worker exits nonzero while unwinding", () => {
    const stopping = { running: true, run_id: "old", _stopRequested: true, exit_code: null };
    const stopped = mergeExecutionStatus(stopping, { running: false, exit_code: 1 });
    expect(getExecutionOutcome(stopped)).toBe("idle");
    const next = mergeExecutionStatus(stopped, { running: true, run_id: "new" });
    expect(getExecutionOutcome(mergeExecutionStatus(next, { running: false, exit_code: 1 }))).toBe("failed");
  });
});
