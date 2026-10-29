import assert from "node:assert/strict";
import { mock } from "bun:test";
import { userProfileTabs } from "../../../src/shared/ProfileTabs";

Object.assign(globalThis, {
  __WITH_TAURI__: true,
  __WITH_ANDROID__: true,
  __WITH_WEBUI__: false,
  __APP_VERSION__: "test",
});

let listedIds = ["default_config"];
const documents: Record<string, any> = {};
const opened = new Map<string, Connection>();

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
    if (this.name !== "sync") return;
    if (message.type === "list") {
      this.receive?.({ type: "config_list", data: listedIds });
      return;
    }
    if (message.type !== "pull") return;
    const data =
      message.resource === "static"
        ? { ready: true }
        : message.resource === "setup_toml"
          ? { no_update: true }
          : message.resource === "event"
            ? []
            : documents[message.resource_id];
    if (data !== undefined)
      this.receive?.({
        type: "snapshot",
        resource: message.resource,
        resource_id: message.resource_id,
        data,
      });
  }
  close() {
    this.readyState = 3;
  }
}

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
mock.module("../../../src/shared/TauriInvoke", () => ({
  invoke: async () => ({ config: { general: { no_update: true } } }),
}));

const { useWebSocketStore: store } = await import("../../../src/store/WebsocketStore");
store.setState({ _auth_phase: "authenticated", transportMode: "pipe" });
await Promise.race([
  store.getState().init(),
  Bun.sleep(3000).then(() => {
    throw new Error("template-only initialization stayed blocked");
  }),
]);
assert.equal(
  store.getState()._android_ui_ready,
  true,
  "zero user profiles is a valid initialized Android workspace"
);
assert.deepEqual(store.getState().configStore, {}, "the built-in template is not a user profile");
const sync = opened.get("sync")!;
assert.ok(
  !sync.sent.some((message) => message.resource_id === "default_config"),
  "initialization must not pull template snapshots"
);

const visibleNames: string[][] = [];
const stop = store.subscribe((state) =>
  visibleNames.push(userProfileTabs(state.configStore).map((tab) => tab.name))
);
const copiedId = "1793236142124";
listedIds = ["default_config", copiedId];
sync.receive!({ type: "config_list", data: listedIds });
assert.deepEqual(
  store.getState().configStore[copiedId],
  {},
  "the ID may arrive before its document"
);
assert.deepEqual(
  userProfileTabs(store.getState().configStore),
  [],
  "ID-only entries cannot render blank tabs"
);
sync.receive!({
  type: "snapshot",
  resource: "config",
  resource_id: "default_config",
  data: { name: "" },
});
assert.ok(
  !("default_config" in store.getState().configStore),
  "a late template snapshot cannot resurrect its tab"
);

documents[copiedId] = { name: "New Profile (copy)", server: "CN", ap: {}, _pass: {} };
sync.receive!({
  type: "patch",
  resource: "config",
  resource_id: copiedId,
  ops: [{ op: "add", path: "", value: {} }],
});
assert.deepEqual(
  store.getState().configStore[copiedId],
  documents[copiedId],
  "a synchronous pulled snapshot must not be overwritten by the add notification's empty value"
);
assert.deepEqual(
  userProfileTabs(store.getState().configStore).map((tab) => tab.id),
  [copiedId],
  "the user's copied profile is retained"
);
sync.receive!({ type: "config_list", data: listedIds });
assert.equal(
  store.getState().configStore[copiedId].name,
  "New Profile (copy)",
  "a repeated list cannot blank hydrated metadata"
);

const addedId = "new-real-profile";
documents[addedId] = { name: "Daily tasks", server: "JP", ap: {}, _pass: {} };
listedIds.push(addedId);
sync.receive!({
  type: "patch",
  resource: "config",
  resource_id: addedId,
  ops: [{ op: "add", path: "", value: {} }],
});
assert.deepEqual(
  userProfileTabs(store.getState().configStore).map((tab) => tab.name),
  ["New Profile (copy)", "Daily tasks"],
  "creating after an empty first install yields named tabs"
);
const beforeNestedPatch = sync.sent.length;
sync.receive!({
  type: "patch",
  resource: "config",
  resource_id: addedId,
  ops: [{ op: "add", path: "/ap/trace", value: "enabled" }],
});
assert.equal(
  store.getState().configStore[addedId].ap.trace,
  "enabled",
  "nested add applies to the existing config document"
);
sync.receive!({
  type: "patch",
  resource: "config",
  resource_id: addedId,
  ops: [{ op: "remove", path: "/ap/trace" }],
});
assert.ok(
  !("trace" in store.getState().configStore[addedId].ap),
  "nested remove deletes only its field"
);
assert.equal(
  sync.sent.length,
  beforeNestedPatch,
  "nested field edits must not refresh profile membership"
);
assert.equal(
  store.getState().configStore[addedId].name,
  "Daily tasks",
  "nested edits preserve profile metadata"
);
assert.ok(
  visibleNames.every((names) => names.every((name) => name.trim().length > 0)),
  "no intermediate store event renders an empty profile name"
);
stop();
for (const name of ["provider", "sync", "trigger"] as const) store.getState().disconnect(name);
console.log("first-install profile initialization regression passed");
