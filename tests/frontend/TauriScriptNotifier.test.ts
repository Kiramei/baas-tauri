import { describe, expect, test } from "bun:test";
import { createStatusSnapshot } from "../../src/components/tauriScriptNotifierState";

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
        }
      )
    ).toMatchObject({ currentTask: null, lastTask: "competition" });
  });
});
