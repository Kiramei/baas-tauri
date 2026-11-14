import assert from "node:assert/strict";
import { mock } from "bun:test";

Object.assign(globalThis, {
  __WITH_TAURI__: true,
  __WITH_ANDROID__: false,
  __APP_VERSION__: "test",
  document: { visibilityState: "visible" },
});
let focused = true;
const nativeCalls: unknown[] = [];
mock.module("sonner", () => ({ toast: { error() {}, warning() {}, success() {}, info() {} } }));
mock.module("../../../src/shared/TauriInvoke", () => ({
  invoke: async (command: string, args: unknown) => {
    if (command === "baas_notify") nativeCalls.push(args);
    return {};
  },
}));
mock.module("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => focused }),
}));
mock.module("../../../src/shared/StorageManager.ts", () => ({
  default: { get: () => null, set() {}, init: async () => {} },
}));
class Connection {
  readyState = 1;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
  receive?: (message: unknown) => void;
  async connect(receive: (message: unknown) => void) {
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
const { useWebSocketStore } = await import("../../../src/store/WebsocketStore");
const { subscribeScriptStatus } = await import("../../../src/shared/ScriptStatusEvents");
const { ScriptNotificationTracker } =
  await import("../../../src/components/tauriScriptNotifierState");
const { createSystemNotificationDelivery, isApplicationBackground } =
  await import("../../../src/shared/SystemNotificationDelivery");
const { getExecutionOutcome } = await import("../../../src/shared/ExecutionOutcome");
assert.equal(
  await isApplicationBackground(),
  false,
  "foreground Tauri window must suppress even when DOM focus is unknown"
);
focused = false;
assert.equal(await isApplicationBackground(), true);
const delivery = createSystemNotificationDelivery(
  () => true,
  (latest) => latest
);
await delivery.enqueue({
  key: "mock-only",
  group: "script:completed",
  payload: { title: "mock", body: "mock", tag: "script:a:completed" },
});
await delivery.flush();
delivery.clear();
assert.equal(nativeCalls.length, 1, "only the mocked native command may be called");

const events: string[] = [];
const tracker = new ScriptNotificationTracker();
const unsubscribe = subscribeScriptStatus((delivery) =>
  events.push(...tracker.accept(delivery).map((event) => event.kind))
);
useWebSocketStore.setState({ _auth_phase: "authenticated", init: async () => {} });
await useWebSocketStore.getState().connect("provider");
await useWebSocketStore.getState().connect("trigger");
let provider = opened.get("provider")!;
const baseline = {
  config_id: "a",
  running: true,
  current_task: "competition",
  waiting_tasks: [],
  run_mode: "scheduler",
  run_id: "run-1",
  timestamp: 200,
};
provider.receive!({ type: "status", status: { a: baseline } });
assert.deepEqual(events, [], "the provider's whole-map status is always a silent baseline");
provider.receive!({
  type: "status",
  status: { config_id: "a", status: { ...baseline, current_task: null, timestamp: 150 } },
});
assert.equal(
  useWebSocketStore.getState().statusStore.a.current_task,
  "competition",
  "pre-snapshot queue entries cannot roll back the UI either"
);
assert.deepEqual(events, []);
provider.receive!({
  type: "status",
  status: { config_id: "a", status: { ...baseline, current_task: null, timestamp: 201 } },
});
assert.deepEqual(events, ["completed"]);

// A real user stop marks the current run, even if its worker exits with an error marker.
useWebSocketStore
  .getState()
  .trigger({ command: "stop_scheduler", config_id: "a", timestamp: 1, payload: {} });
assert.equal(useWebSocketStore.getState().statusStore.a._stopRequested, true);
provider.receive!({
  type: "status",
  status: { config_id: "a", status: { running: false, exit_code: 1, timestamp: 202 } },
});
assert.equal(getExecutionOutcome(useWebSocketStore.getState().statusStore.a), "idle");
assert.deepEqual(events, ["completed"]);
provider.receive!({
  type: "status",
  status: { config_id: "a", status: { ...baseline, run_id: "run-2", timestamp: 203 } },
});
assert.equal(useWebSocketStore.getState().statusStore.a._stopRequested, false);
assert.equal(useWebSocketStore.getState().statusStore.a.exit_code, null);
provider.receive!({
  type: "status",
  status: {
    config_id: "a",
    status: { running: false, current_task: null, exit_code: 1, timestamp: 204 },
  },
});
assert.equal(getExecutionOutcome(useWebSocketStore.getState().statusStore.a), "failed");
assert.deepEqual(events, ["completed", "started", "failed"]);

provider.receive!({
  type: "status",
  status: { config_id: "a", status: { ...baseline, run_id: "run-3", timestamp: 205 } },
});
const stopToken = useWebSocketStore
  .getState()
  .trigger({ command: "stop_scheduler", config_id: "a", timestamp: 2, payload: {} });
provider.receive!({
  type: "status",
  status: { config_id: "a", status: { current_task: "competition", timestamp: 206 } },
});
opened.get("trigger")!.receive!({
  type: "command_response",
  command: "stop_scheduler",
  timestamp: stopToken,
  status: "error",
  error: "stop rejected",
});
assert.equal(
  useWebSocketStore.getState().statusStore.a._stopRequested,
  false,
  "a failed stop ACK must clear its token after partial provider updates"
);
assert.equal(
  useWebSocketStore.getState().statusStore.a.current_task,
  "competition",
  "clearing intent must preserve newer status fields"
);
provider.receive!({
  type: "status",
  status: {
    config_id: "a",
    status: { running: false, current_task: null, exit_code: 1, timestamp: 207 },
  },
});
assert.equal(getExecutionOutcome(useWebSocketStore.getState().statusStore.a), "failed");
assert.deepEqual(events, ["completed", "started", "failed", "started", "failed"]);

provider.receive!({
  type: "status",
  status: { config_id: "a", status: { ...baseline, run_id: "run-4", timestamp: 208 } },
});
const oldStop = useWebSocketStore
  .getState()
  .trigger({ command: "stop_scheduler", config_id: "a", timestamp: 3, payload: {} });
const newStop = useWebSocketStore
  .getState()
  .trigger({ command: "stop_scheduler", config_id: "a", timestamp: 4, payload: {} });
opened.get("trigger")!.receive!({
  type: "command_response",
  command: "stop_scheduler",
  timestamp: oldStop,
  status: "error",
  error: "old stop rejected",
});
assert.equal(
  useWebSocketStore.getState().statusStore.a._stopRequestToken,
  newStop,
  "an old error ACK must not cancel a newer stop request"
);
assert.equal(useWebSocketStore.getState().statusStore.a._stopRequested, true);
const beforeLateFailure = [...events];
provider.receive!({
  type: "status",
  status: {
    config_id: "a",
    status: { running: false, current_task: null, exit_code: 1, timestamp: 209 },
  },
});
assert.deepEqual(
  events,
  beforeLateFailure,
  "the pending stop temporarily suppresses the terminal marker"
);
opened.get("trigger")!.receive!({
  type: "command_response",
  command: "stop_scheduler",
  timestamp: newStop,
  status: "error",
  error: "stop rejected after worker failure",
});
assert.deepEqual(
  events,
  [...beforeLateFailure, "failed"],
  "a late rejected stop must reveal the real terminal failure exactly once"
);
assert.equal(getExecutionOutcome(useWebSocketStore.getState().statusStore.a), "failed");
const beforeReconnect = [...events];

// Recovery invalidates the source immediately, and restored state never replays completion.
provider.close();
for (let index = 0; index < 80; index++) await Promise.resolve();
const oldProvider = provider;
provider = opened.get("provider")!;
assert.notEqual(provider, oldProvider);
provider.receive!({
  type: "status",
  status: { a: { ...baseline, running: false, current_task: null, timestamp: 300 } },
});
provider.receive!({
  type: "status",
  status: { config_id: "a", status: { ...baseline, timestamp: 299 } },
});
assert.deepEqual(events, beforeReconnect);
provider.receive!({
  type: "status",
  status: { config_id: "new-profile", status: { running: false, exit_code: 1, timestamp: 301 } },
});
assert.deepEqual(
  events,
  [...beforeReconnect, "failed"],
  "a fresh initialization error can fail before a running status exists"
);
unsubscribe();
useWebSocketStore.getState().disconnect("provider");
useWebSocketStore.getState().disconnect("trigger");
await Bun.sleep(25);
