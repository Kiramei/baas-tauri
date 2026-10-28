import assert from "node:assert/strict";
import { mock } from "bun:test";

Object.assign(globalThis, {
  __WITH_TAURI__: true,
  __WITH_ANDROID__: false,
  __WITH_WEBUI__: false,
  __APP_VERSION__: "test",
});

const documents: Record<string, any> = {
  one: { main_story_regions: "1", manual_boss: false, nested: { child: "original", sibling: 1 } },
  two: { main_story_regions: "1" },
};
const accepted: any[] = [];
class Connection {
  readyState = 1;
  receive?: (message: any) => void;
  sent: any[] = [];
  constructor(readonly name: string) {}
  async connect(receive: (message: any) => void) {
    this.receive = receive;
  }
  sendJson(message: any) {
    this.sent.push(message);
    if (message.command === "solve") {
      accepted.push(structuredClone(documents[message.config_id]));
      queueMicrotask(() =>
        this.receive?.({
          type: "command_response",
          command: "solve",
          timestamp: message.timestamp,
          status: "ok",
          data: { status: "ok" },
        })
      );
    }
  }
  close() {
    this.readyState = 3;
  }
}
const opened = new Map<string, Connection>();
mock.module("../../../src/transport/factory", () => ({
  configuredTransportMode: async () => "pipe",
  normalizeTransportMode: () => "pipe",
  startBackendTransport: async () => ({}),
  openBackendChannel: async ({ name }: { name: string }) => {
    const connection = new Connection(name);
    opened.set(name, connection);
    return connection;
  },
}));
mock.module("../../../src/shared/StorageManager.ts", () => ({
  default: { get: () => null, set() {}, init: async () => {} },
}));

const { useWebSocketStore: store } = await import("../../../src/store/WebsocketStore");
const { runStageTaskAfterSave } = await import("../../../src/features/upstreamConfig");
store.setState({
  _auth_phase: "authenticated",
  init: async () => {},
  configStore: structuredClone(documents),
});
await store.getState().connect("sync");
await store.getState().connect("trigger");
const sync = opened.get("sync")!;
const trigger = opened.get("trigger")!;
const acknowledge = (request: any, resourceId = request.resource_id) =>
  sync.receive!({
    type: "patch_ack",
    resource: request.resource,
    resource_id: resourceId,
    timestamp: request.timestamp,
  });
const conflict = (request: any, timestamp = request.timestamp + 1) =>
  sync.receive!({
    type: "patch_conflict",
    resource: request.resource,
    resource_id: request.resource_id,
    request_timestamp: request.timestamp,
    timestamp,
    data: structuredClone(documents[request.resource_id]),
  });
const apply = (request: any) => {
  for (const operation of request.ops) {
    const path = operation.path
      .split("/")
      .slice(1)
      .map((part: string) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let parent = documents[request.resource_id];
    for (const part of path.slice(0, -1)) parent = parent[part];
    parent[path.at(-1)!] = structuredClone(operation.value);
  }
};

const originalNow = Date.now;
try {
  Date.now = () => 100;

  // An old automatic save conflicts after a newer explicit action save was sent.
  store.getState().modify("one::config", { main_story_regions: "2", manual_boss: true });
  const old = sync.sent.at(-1);
  const launching = runStageTaskAfterSave(
    store.getState,
    "one",
    "start_main_story",
    { main_story_regions: "3,1" },
    () => {},
    { saveTimeoutMs: 100, commandTimeoutMs: 100 }
  );
  const final = sync.sent.at(-1);
  conflict(old, old.timestamp);
  const retried = sync.sent.at(-1);
  assert.deepEqual(
    retried.ops,
    [{ op: "replace", path: "/manual_boss", value: true }],
    "only independent old fields may retry"
  );
  // The server may finish both queued disk writes before the client sees the final save's ACK.
  apply(final);
  apply(retried);
  acknowledge(final);
  await launching;
  acknowledge(retried);
  assert.equal(
    accepted.at(-1).main_story_regions,
    "3,1",
    "task acceptance must see the final order"
  );
  assert.equal(accepted.at(-1).manual_boss, true, "independent automatic settings are retained");
  assert.deepEqual(store.getState().pendingCallbacks, {});

  // Coverage must survive a newer write's ACK, without retaining a completed-write log.
  store.getState().modify("one::config", { main_story_regions: "2", manual_boss: false });
  const earlier = sync.sent.at(-1);
  store.getState().modify("one::config", { main_story_regions: "1,3" });
  const later = sync.sent.at(-1);
  apply(later);
  acknowledge(later);
  conflict(earlier, earlier.timestamp);
  const retryAfterAck = sync.sent.at(-1);
  assert.deepEqual(retryAfterAck.ops, [{ op: "replace", path: "/manual_boss", value: false }]);
  apply(retryAfterAck);
  acknowledge(retryAfterAck);
  assert.equal(documents.one.main_story_regions, "1,3");
  assert.equal(documents.one.manual_boss, false);

  // Cancelling one operation cannot let its late ACK complete the next profile's write.
  const cancel = store.getState().modify("one::config", { main_story_regions: "2" });
  const cancelled = sync.sent.at(-1);
  cancel?.();
  const commandCount = trigger.sent.length;
  const secondLaunching = runStageTaskAfterSave(
    store.getState,
    "two",
    "start_main_story",
    { main_story_regions: "3,1" },
    () => {},
    { saveTimeoutMs: 100, commandTimeoutMs: 100 }
  );
  const next = sync.sent.at(-1);
  assert.ok(next.timestamp > cancelled.timestamp, "cancelled request IDs must never be reused");
  acknowledge(cancelled);
  acknowledge(next, "one");
  await Promise.resolve();
  assert.equal(
    trigger.sent.length,
    commandCount,
    "late or wrong-profile ACKs cannot launch a task"
  );
  apply(next);
  acknowledge(next);
  await secondLaunching;
  assert.equal(accepted.at(-1).main_story_regions, "3,1");

  // Older parent replacements may not roll back a newer child; unrelated fields still retry.
  store
    .getState()
    .modify("one::config", { nested: { child: "old", sibling: 9 }, manual_boss: true });
  const parent = sync.sent.at(-1);
  store.getState().modify("one::config", { "nested/child": "latest" });
  const child = sync.sent.at(-1);
  apply(child);
  acknowledge(child);
  conflict(parent, parent.timestamp);
  const parentRetry = sync.sent.at(-1);
  assert.deepEqual(parentRetry.ops, [{ op: "replace", path: "/manual_boss", value: true }]);
  apply(parentRetry);
  acknowledge(parentRetry);
  assert.equal(documents.one.nested.child, "latest");

  // A later root replacement retires every overlapping older field operation.
  store.getState().modify("one::config", { manual_boss: false });
  const field = sync.sent.at(-1);
  const cancelRoot = store.getState().modify("one::config", []);
  const sends = sync.sent.length;
  conflict(field, field.timestamp);
  assert.equal(sync.sent.length, sends, "superseded root children cannot retry");
  cancelRoot?.();

  // A callback cancelled before conflict must also follow a retry's new wire ID.
  const cancelRetry = store.getState().modify("one::config", { manual_boss: false });
  const toCancel = sync.sent.at(-1);
  conflict(toCancel, toCancel.timestamp);
  const moved = sync.sent.at(-1);
  assert.notEqual(moved.timestamp, toCancel.timestamp);
  cancelRetry?.();
  acknowledge(moved);
  assert.deepEqual(store.getState().pendingCallbacks, {});

  // Scope isolation: a write to another profile cannot retire this profile's retry.
  store.getState().modify("one::config", { main_story_regions: "2" });
  const isolated = sync.sent.at(-1);
  store.getState().modify("two::config", { main_story_regions: "3" });
  const other = sync.sent.at(-1);
  conflict(isolated, isolated.timestamp);
  const isolatedRetry = sync.sent.at(-1);
  assert.deepEqual(isolatedRetry.ops, [{ op: "replace", path: "/main_story_regions", value: "2" }]);
  acknowledge(other);
  acknowledge(isolatedRetry);

  // A synchronous conflict-snapshot subscriber can publish newer intent too.
  store.getState().modify("one::config", { main_story_regions: "2" });
  const supersededBySubscriber = sync.sent.at(-1);
  let responding = false;
  const unsubscribe = store.subscribe((state, previous) => {
    if (responding || state.configStore.one === previous.configStore.one) return;
    responding = true;
    store.getState().modify("one::config", { main_story_regions: "3,1" });
  });
  conflict(supersededBySubscriber, supersededBySubscriber.timestamp);
  unsubscribe();
  assert.equal(
    sync.sent.at(-1).ops[0].value,
    "3,1",
    "snapshot subscribers' newer edits must not be followed by an old retry"
  );
  acknowledge(sync.sent.at(-1));

  // Undo remains available outside Stage's disabled fieldset. Saving a surviving
  // independent field cannot confirm the original complete action configuration.
  Date.now = originalNow;
  const acceptedBeforeUndo = accepted.length;
  const interruptedLaunch = runStageTaskAfterSave(
    store.getState,
    "one",
    "start_main_story",
    { main_story_regions: "3,1", manual_boss: false },
    () => {},
    { saveTimeoutMs: 8, commandTimeoutMs: 100 }
  );
  const completeSave = sync.sent.at(-1);
  store.getState().modify("one::config", { main_story_regions: "1" });
  const undoSave = sync.sent.at(-1);
  conflict(completeSave, completeSave.timestamp);
  const partialSave = sync.sent.at(-1);
  assert.deepEqual(partialSave.ops, [{ op: "replace", path: "/manual_boss", value: false }]);
  apply(undoSave);
  acknowledge(undoSave);
  apply(partialSave);
  acknowledge(partialSave);
  await assert.rejects(interruptedLaunch, { code: "save_unconfirmed" });
  assert.equal(
    accepted.length,
    acceptedBeforeUndo,
    "a partial save ACK must not launch the original task"
  );
  assert.equal(documents.one.manual_boss, false, "independent autosave fields still persist");
  assert.equal(documents.one.main_story_regions, "1", "undo retains its newer configuration");
  assert.deepEqual(store.getState().pendingCallbacks, {});

  // Repeated overlapping edits keep only live intent, with no growing history/callback table.
  for (let i = 0; i < 1000; i += 1)
    store.getState().modify("one::config", { main_story_regions: String(i) });
  assert.equal(Object.keys(store.getState().pendingCallbacks).length, 1);
  acknowledge(sync.sent.at(-1));
  assert.deepEqual(store.getState().pendingCallbacks, {});
  console.log("sync ordering regression passed");
} finally {
  Date.now = originalNow;
  store.getState().disconnect("sync");
  store.getState().disconnect("trigger");
}
