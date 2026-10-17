import assert from "node:assert/strict";
import { mock } from "bun:test";

Object.assign(globalThis, {
  __WITH_TAURI__: true,
  __WITH_ANDROID__: false,
  __APP_VERSION__: "test",
});

class Connection {
  readyState = 1;
  onClose?: (event: CloseEvent) => void;
  receive?: (message: any) => void;

  async connect(receive: (message: any) => void) {
    this.receive = receive;
  }
  sendJson() {}
  sendBytes() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onClose?.({} as CloseEvent);
  }
}

const opened = new Map<string, Connection>();
mock.module("../../../src/transport/factory", () => ({
  configuredTransportMode: async () => "pipe",
  normalizeTransportMode: () => "pipe",
  startBackendTransport: async () => ({}),
  openBackendChannel: async ({ name }: { name: string }) => {
    const connection = new Connection();
    opened.set(name, connection);
    return connection;
  },
}));
mock.module("../../../src/shared/StorageManager.ts", () => ({
  default: { get: () => null, set() {}, init: async () => {} },
}));

const { useWebSocketStore: store } = await import("../../../src/store/WebsocketStore");
const running = (id: string) => ({
  config_id: id,
  running: true,
  current_task: "lesson",
  waiting_tasks: ["mail"],
  timestamp: 123,
});
const configs = { global: { name: "Global", server: "Global" }, cn: { name: "CN", server: "CN" } };
const logs = { "config:global": [{ message: "before recovery" }] };
store.setState({
  _auth_phase: "authenticated",
  init: async () => {},
  configStore: configs,
  logStore: logs as any,
  statusStore: { global: running("global") },
});

await store.getState().connect("provider");
const oldProvider = opened.get("provider")!;
assert.deepEqual(store.getState().statusStore, {}, "a provider must not inherit old running flags");
assert.equal(store.getState().configStore, configs, "saved settings survive reconnection");
assert.equal(store.getState().logStore, logs, "received logs survive reconnection");

const receive = (status: unknown) => oldProvider.receive!({ type: "status", status });
receive({ global: running("global") });
receive({ cn: running("cn") });
assert.equal(store.getState().statusStore.global.running, true, "map updates retain other profiles");
receive({ config_id: "global", status: { current_task: "cafe" } });
assert.equal(store.getState().statusStore.global.running, true, "partial updates retain running state");
assert.equal(store.getState().statusStore.global.current_task, "cafe");
assert.deepEqual(store.getState().statusStore.global.waiting_tasks, ["mail"]);
receive({ is_all_data_initialized: true });
receive({ version: { local: "test" } });
assert.equal(store.getState().statusStore.cn.running, true, "metadata is not an empty status snapshot");

// This is the legacy provider payload from a backend that has just restarted.
receive({});
assert.deepEqual(store.getState().statusStore, {}, "an empty snapshot clears every old session");
assert.equal(Object.hasOwn(store.getState().statusStore, "undefined"), false);
receive({ config_id: null, status: {} });
assert.deepEqual(store.getState().statusStore, {}, "invalid wrapped statuses cannot create phantom keys");

receive({ global: running("global"), cn: running("cn") });
await store.getState().connect("trigger");
assert.equal(store.getState().statusStore.global.running, true, "opening trigger does not clear provider data");
const trigger = opened.get("trigger")!;
let acknowledgement = false;
store.getState().trigger(
  { command: "stop_scheduler", config_id: "global", timestamp: 1000, payload: {} },
  () => { acknowledgement = true; }
);
trigger.receive!({
  type: "command_response", command: "stop_scheduler", timestamp: 1000, status: "ok",
  data: { status: "unknown-config", config_id: "global" },
});
assert.equal(acknowledgement, true, "legacy unknown-config responses still reach the caller");
assert.equal(store.getState().statusStore.global, undefined, "unknown sessions cannot stay running");
assert.equal(store.getState().statusStore.cn.running, true, "the other profile remains unaffected");
assert.equal(store.getState().pendingCallbacks[1000], undefined, "the internal stop callback is released");

// Trigger replies and provider updates travel over separate channels. A new run
// can become visible before an earlier stop's unknown-config reply is delivered.
receive({ global: running("global") });
store.getState().trigger(
  { command: "stop_scheduler", config_id: "global", timestamp: 1001, payload: {} }
);
const newerRun = { ...running("global"), timestamp: 456, current_task: "mail" };
receive({ config_id: "global", status: newerRun });
const newerState = store.getState().statusStore.global;
trigger.receive!({
  type: "command_response", command: "stop_scheduler", timestamp: 1001, status: "ok",
  data: { status: "unknown-config", config_id: "global" },
});
assert.equal(store.getState().statusStore.global, newerState, "a delayed ACK must preserve a newer run");
assert.equal(store.getState().statusStore.global.running, true);
assert.equal(store.getState().pendingCallbacks[1001], undefined);

// Stops without an external callback still correct an unchanged stale session.
store.getState().trigger(
  { command: "stop_scheduler", config_id: "global", timestamp: 1002, payload: {} }
);
trigger.receive!({
  type: "command_response", command: "stop_scheduler", timestamp: 1002, status: "ok",
  data: { status: "unknown-config", config_id: "global" },
});
assert.equal(store.getState().statusStore.global, undefined);
assert.equal(store.getState().pendingCallbacks[1002], undefined);
assert.equal(store.getState().statusStore.cn.running, true);

// An error or a mismatched config in a response is not proof the run was lost.
store.getState().trigger(
  { command: "stop_scheduler", config_id: "cn", timestamp: 1003, payload: {} }
);
trigger.receive!({
  type: "command_response", command: "stop_scheduler", timestamp: 1003, status: "error",
  data: { status: "unknown-config", config_id: "cn" },
});
assert.equal(store.getState().statusStore.cn.running, true);
store.getState().trigger(
  { command: "stop_scheduler", config_id: "cn", timestamp: 1004, payload: {} }
);
trigger.receive!({
  type: "command_response", command: "stop_scheduler", timestamp: 1004, status: "ok",
  data: { status: "unknown-config", config_id: "global" },
});
assert.equal(store.getState().statusStore.cn.running, true);

// A new process after a transport outage must not reuse the old session state,
// even before its first provider status message arrives.
store.getState().send("provider", { type: "status_request" });
oldProvider.close();
assert.deepEqual(store.getState().statusStore, {}, "connection invalidation clears stale runtime state");
for (let index = 0; index < 50; index += 1) await Promise.resolve();
const newProvider = opened.get("provider")!;
assert.notEqual(newProvider, oldProvider);
newProvider.receive!({ type: "status", status: {} });
oldProvider.receive!({ type: "status", status: { global: running("global") } });
assert.deepEqual(store.getState().statusStore, {}, "retired providers cannot restore stale running state");
newProvider.receive!({ type: "status", status: { cn: running("cn") } });
assert.equal(store.getState().statusStore.cn.running, true, "active sessions are restored from the new provider");
assert.equal(store.getState().configStore, configs);
assert.equal(store.getState().logStore, logs);
for (const name of ["provider", "trigger"] as const) store.getState().disconnect(name);
await Bun.sleep(25);
console.log("status recovery regression passed");
