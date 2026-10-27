import { describe, expect, test } from "bun:test";
import { saveConfigurationPatch } from "../../src/shared/ConfigurationSave";

function fixture() {
  let acknowledge: (() => void) | undefined;
  let cancelled = 0;
  const writes: unknown[] = [];
  const state = {
    _auth_phase: "authenticated",
    _session: {},
    connections: { sync: { readyState: 1 }, trigger: { readyState: 1 } },
    modify: (path: string, patch: unknown, _toast?: boolean, callback?: () => void) => {
      writes.push({ path, patch });
      acknowledge = callback;
      return () => {
        cancelled += 1;
      };
    },
  };
  return {
    state,
    writes,
    getState: () => state as any,
    ack: () => acknowledge?.(),
    cancellations: () => cancelled,
  };
}

describe("configuration acknowledgement before execution", () => {
  test("matching local values cannot replace the actual patch ACK", async () => {
    const store = fixture();
    let saved = false;
    const result = saveConfigurationPatch(store.getState, "one", {
      main_story_regions: "2,1",
    }).then(() => {
      saved = true;
    });
    await Promise.resolve();
    expect(saved).toBe(false);
    expect(store.writes).toEqual([{ path: "one::config", patch: { main_story_regions: "2,1" } }]);
    store.ack();
    await result;
    expect(saved).toBe(true);
    expect(store.cancellations()).toBe(1);
  });

  test("missing ACK fails and releases its pending write", async () => {
    const store = fixture();
    await expect(
      saveConfigurationPatch(store.getState, "one", { manual_boss: true }, { timeoutMs: 5 })
    ).rejects.toThrow("not acknowledged");
    expect(store.cancellations()).toBe(1);
  });

  test("unmount abort cancels the pending write and never accepts a late ACK", async () => {
    const store = fixture();
    const controller = new AbortController();
    const saving = saveConfigurationPatch(
      store.getState,
      "one",
      { manual_boss: true },
      { signal: controller.signal }
    );
    controller.abort();
    await expect(saving).rejects.toThrow("cancelled");
    store.ack();
    expect(store.cancellations()).toBe(1);
  });

  test("a replaced authentication session cannot complete an older action", async () => {
    const store = fixture();
    const saving = saveConfigurationPatch(store.getState, "one", { manual_boss: true });
    store.state._session = {};
    store.ack();
    await expect(saving).rejects.toThrow("session changed");
    expect(store.cancellations()).toBe(1);
  });

  test("connection replacement is detected before accepting an ACK", async () => {
    const store = fixture();
    const saving = saveConfigurationPatch(store.getState, "one", { manual_boss: true });
    store.state.connections.trigger = { readyState: 1 };
    store.ack();
    await expect(saving).rejects.toThrow("session changed");
  });

  test("unavailable channels and pre-cancelled operations never send", async () => {
    const store = fixture();
    store.state.connections.sync.readyState = 3;
    await expect(
      saveConfigurationPatch(store.getState, "one", { manual_boss: true })
    ).rejects.toThrow("required");
    const controller = new AbortController();
    controller.abort();
    await expect(
      saveConfigurationPatch(
        store.getState,
        "one",
        { manual_boss: true },
        { signal: controller.signal }
      )
    ).rejects.toThrow("cancelled");
    expect(store.writes).toEqual([]);
  });
});
