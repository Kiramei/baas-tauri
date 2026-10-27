import assert from "node:assert/strict";
import { mock } from "bun:test";

Object.assign(globalThis, {
  __WITH_TAURI__: true,
  __WITH_ANDROID__: false,
  __APP_VERSION__: "test",
});
const unrelated = () => {};
let allocatedId = 1042;
const state = {
  connections: { trigger: {} },
  pendingCallbacks: { "1000.5": unrelated } as Record<string, (response: any) => void>,
  trigger: (_request: any, callback: (response: any) => void) => {
    state.pendingCallbacks[allocatedId] = callback;
    return allocatedId;
  },
};
mock.module("../../../src/store/WebsocketStore", () => ({
  useWebSocketStore: { getState: () => state },
  isTauriNoUpdateEnabled: async () => false,
}));
mock.module("../../../src/shared/GlobalUtilities", () => ({ getTimestampMs: () => 1000.5 }));
mock.module("../../../src/context/UISettingsProvider", () => ({ useUISetting: () => false }));
mock.module("../../../src/shared/StorageManager", () => ({ default: { get: () => null } }));
const { command } = await import("../../../src/components/IdleBackendUpdater");

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let expire: (() => void) | undefined;
let cleared = false;
globalThis.setTimeout = ((callback: () => void, delay: number) => {
  assert.equal(delay, 30_000);
  expire = callback;
  return 123;
}) as any;
globalThis.clearTimeout = (() => {
  cleared = true;
}) as any;
try {
  const pending = command("status");
  assert.equal(typeof state.pendingCallbacks[1042], "function");
  expire!();
  await assert.rejects(pending, /Backend command timed out: status/);
  assert.equal(state.pendingCallbacks[1042], undefined, "clear the actual allocated callback ID");
  assert.equal(
    state.pendingCallbacks[1000.5],
    unrelated,
    "preserve another request at the original ID"
  );

  allocatedId = 1043;
  const success = command("stop_all_tasks");
  state.pendingCallbacks[1043]({ status: "ok", data: { stopped: true } });
  assert.deepEqual(await success, { stopped: true });
  assert.equal(cleared, true, "normal completion still cancels the timeout");
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}
console.log("idle backend command callback regression passed");
