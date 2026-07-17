import { describe, expect, mock, test } from "bun:test";

Object.assign(globalThis, { __WITH_TAURI__: true, __WITH_ANDROID__: false });

const invoke = mock(async () => ({
  generation: "0".repeat(64),
  disposition: "committed",
  backendOutcome: "python_unchanged",
}));

mock.module("@/shared/TauriInvoke", () => ({ invoke }));

describe("runtime repository signed-plan helper", () => {
  test("sends only one opaque string envelope", async () => {
    const { applyRuntimeRepositorySignedPlan } =
      await import("../../src/runtimeRepository/applySignedPlan");
    await applyRuntimeRepositorySignedPlan("opaque-signed-envelope");
    expect(invoke).toHaveBeenLastCalledWith("runtime_repository_apply_signed_plan", {
      request: { envelope: "opaque-signed-envelope" },
    });
  });

  test("copies opaque bytes without adding repository policy fields", async () => {
    const { applyRuntimeRepositorySignedPlan } =
      await import("../../src/runtimeRepository/applySignedPlan");
    await applyRuntimeRepositorySignedPlan(new Uint8Array([123, 125]));
    expect(invoke).toHaveBeenLastCalledWith("runtime_repository_apply_signed_plan", {
      request: { envelope: [123, 125] },
    });
    const serialized = JSON.stringify(invoke.mock.calls.at(-1));
    for (const forbidden of ["url", "ref", "commit", "key", "path", "generation"]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
  });
});
