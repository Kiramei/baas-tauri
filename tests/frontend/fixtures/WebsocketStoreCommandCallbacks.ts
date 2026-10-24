import assert from "node:assert/strict";
import { mock } from "bun:test";

Object.assign(globalThis, {
  __WITH_TAURI__: true,
  __WITH_ANDROID__: false,
  __APP_VERSION__: "test",
});

class Connection {
  readyState = 1;
  receive?: (message: any) => void;
  sent: any[] = [];
  bytes: (ArrayBuffer | Uint8Array)[] = [];
  wire: string[] = [];
  sendFailure?: Error;
  async connect(receive: (message: any) => void) {
    this.receive = receive;
  }
  sendJson(message: any) {
    this.sent.push(message);
    this.wire.push(message.command);
  }
  sendBytes(bytes: ArrayBuffer | Uint8Array) {
    if (this.sendFailure) return Promise.reject(this.sendFailure);
    this.bytes.push(bytes);
    this.wire.push("ZIP bytes");
  }
  close() {
    this.readyState = 3;
  }
}

const connection = new Connection();
mock.module("../../../src/transport/factory", () => ({
  configuredTransportMode: async () => "pipe",
  normalizeTransportMode: () => "pipe",
  startBackendTransport: async () => ({}),
  openBackendChannel: async () => connection,
}));
mock.module("../../../src/shared/StorageManager.ts", () => ({
  default: { get: () => null, set() {}, init: async () => {} },
}));

const { useWebSocketStore: store } = await import("../../../src/store/WebsocketStore");
store.setState({ _auth_phase: "authenticated", init: async () => {} });
await store.getState().connect("trigger");

const zip = new Uint8Array([80, 75]);
let imported: unknown;
store.getState().triggerBinary(
  // The default serde_json bridge re-encodes this value as .4883. It must
  // never be used as a fractional dictionary key on either side of the bridge.
  { timestamp: 1_791_621_186_600.4885, command: "import_config", payload: {} },
  zip,
  (response) => {
    imported = response.data;
  }
);
const importRequest = connection.sent.at(-1)!;
assert.equal(Number.isSafeInteger(importRequest.timestamp), true, "commands use integer wire IDs");
await Promise.resolve();
assert.equal(connection.bytes[0], zip);
// The backend command model uses float, not int. Exercise Python JSON output
// as well: a whole-number float such as 1791621186600.0 is the same JS key.
const python = Bun.spawnSync({
  cmd: ["python3", "-c", "import json, sys; print(json.dumps(float(sys.stdin.read())))"],
  stdin: new TextEncoder().encode(JSON.stringify(importRequest.timestamp)),
  stdout: "pipe",
  stderr: "pipe",
});
assert.equal(python.exitCode, 0);
const echoedTimestamp = JSON.parse(new TextDecoder().decode(python.stdout));
connection.receive!({
  type: "command_response",
  command: "import_config",
  timestamp: echoedTimestamp,
  status: "ok",
  data: { serial: "imported" },
});
assert.deepEqual(imported, { serial: "imported" }, "the import ACK resolves its original callback");
assert.deepEqual(store.getState().pendingCallbacks, {});

const responses: string[] = [];
store
  .getState()
  .trigger({ timestamp: 2000.1, command: "copy_config", payload: {} }, () =>
    responses.push("copy")
  );
store
  .getState()
  .triggerStream({ timestamp: 2000.2, command: "stream", payload: {} }, () =>
    responses.push("stream")
  );
store
  .getState()
  .triggerBinary({ timestamp: 2000.9, command: "import_config", payload: {} }, zip, () =>
    responses.push("import")
  );
const concurrent = connection.sent.slice(-3);
assert.equal(
  new Set(concurrent.map((request) => request.timestamp)).size,
  3,
  "normal, stream and binary commands cannot overwrite each other's callback"
);
for (const request of concurrent) {
  connection.receive!({
    type: "command_response",
    command: request.command,
    timestamp: request.timestamp,
    status: "ok",
    data: { done: true },
  });
}
assert.deepEqual(responses, ["copy", "stream", "import"]);
assert.deepEqual(store.getState().pendingCallbacks, {});
assert.deepEqual(store.getState().pendingStreamCallbacks, {});

// Fire-and-forget operations receive responses too. Their ACK must not steal
// the callback of the next operation issued during the same millisecond.
store.getState().trigger({ timestamp: 3000, command: "remove_config", payload: {} });
let copied = false;
store.getState().trigger({ timestamp: 3000, command: "copy_config", payload: {} }, () => {
  copied = true;
});
const [remove, copy] = connection.sent.slice(-2);
assert.notEqual(remove.timestamp, copy.timestamp);
connection.receive!({
  type: "command_response",
  command: remove.command,
  timestamp: remove.timestamp,
  status: "ok",
  data: {},
});
assert.equal(copied, false, "an unrelated remove ACK cannot finish a copy");
connection.receive!({
  type: "command_response",
  command: copy.command,
  timestamp: copy.timestamp,
  status: "ok",
  data: {},
});
assert.equal(copied, true);
assert.deepEqual(store.getState().pendingCallbacks, {});

const wireStart = connection.wire.length;
store
  .getState()
  .triggerBinary({ timestamp: 3100, command: "import_config", payload: {} }, zip, () => {});
store.getState().trigger({ timestamp: 3101, command: "copy_config", payload: {} }, () => {});
assert.deepEqual(
  connection.wire.slice(wireStart),
  ["import_config", "ZIP bytes", "copy_config"],
  "synchronous WebSocket sends must not yield between a command header and its ZIP bytes"
);
for (const request of connection.sent.slice(-2)) {
  connection.receive!({
    type: "command_response",
    command: request.command,
    timestamp: request.timestamp,
    status: "ok",
    data: {},
  });
}

connection.sendFailure = new Error("Android binary invoke failed");
let failed: any;
store
  .getState()
  .triggerBinary({ timestamp: 4000, command: "import_config", payload: {} }, zip, (response) => {
    failed = response;
  });
for (let index = 0; index < 10; index += 1) await Promise.resolve();
assert.equal(failed?.status, "error", "an asynchronous bytes failure reaches the import callback");
assert.match(failed.error, /Android binary invoke failed/);
assert.deepEqual(store.getState().pendingCallbacks, {});
assert.equal(connection.readyState, 3, "the channel waiting for missing binary bytes must close");
store.getState().disconnect("trigger");
console.log("command callback regression passed");
