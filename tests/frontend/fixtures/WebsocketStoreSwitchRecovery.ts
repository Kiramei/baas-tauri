import assert from "node:assert/strict";
import { mock } from "bun:test";

Object.assign(globalThis, {
  __WITH_TAURI__: true,
  __WITH_ANDROID__: false,
  __APP_VERSION__: "test",
});
let mode = "websocket";
let starts = 0;
let holdSnapshots = false;
let publishReady = true;
let releaseStorage: (() => void) | undefined;
let holdNextStorage = false;
const delayedSnapshots: (() => void)[] = [];
const opened = new Map<string, Connection>();

class Connection {
  readyState = 1;
  onClose?: (event: CloseEvent) => void;
  receive?: (message: any) => void;
  constructor(readonly name: string) {}
  async connect(receive: (message: any) => void) {
    this.receive = receive;
    if (this.name === "provider" && publishReady)
      receive({ type: "status", status: { is_all_data_initialized: true } });
  }
  sendJson(payload: any) {
    if (this.name !== "sync") return;
    if (payload.type === "list") {
      this.receive?.({ type: "config_list", data: ["profile"] });
      return;
    }
    const data =
      payload.resource === "static"
        ? { ready: true }
        : payload.resource === "event"
          ? []
          : { id: "profile" };
    const receive = () =>
      this.receive?.({
        type: "snapshot",
        resource: payload.resource,
        resource_id: payload.resource_id,
        data,
      });
    if (holdSnapshots && ["config", "event"].includes(payload.resource))
      delayedSnapshots.push(receive);
    else receive();
  }
  sendBytes() {}
  close() {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.onClose?.({} as CloseEvent);
    }
  }
}
const session = { sessionId: "session" };
const controls: any[] = [];
mock.module("../../../src/shared/SecureWebSocket", () => ({
  ControlConnection: {
    open: async () => {
      const control = {
        initialized: true,
        pwdEpoch: 0,
        resumeWithCookie: async () => session,
        close() {},
      };
      controls.push(control);
      return control;
    },
  },
  randomUUID: () => "uuid",
  rememberControlSession: async () => {},
}));
mock.module("../../../src/transport/factory", () => ({
  configuredTransportMode: async () => mode,
  normalizeTransportMode: (value: string | undefined) => value ?? "websocket",
  startBackendTransport: async (value: string) => {
    starts++;
    mode = value;
    await Bun.sleep(20);
    return { baseBackendAddr: "127.0.0.1", baseBackendPort: 8192 };
  },
  openBackendChannel: async ({ name }: { name: string }) => {
    const connection = new Connection(name);
    opened.set(name, connection);
    return connection;
  },
}));
mock.module("../../../src/shared/StorageManager.ts", () => ({
  default: {
    get: () => null,
    set() {},
    init: async () => {
      if (holdNextStorage) {
        holdNextStorage = false;
        await new Promise<void>((resolve) => {
          releaseStorage = resolve;
        });
      }
    },
  },
}));
mock.module("../../../src/shared/TauriInvoke", () => ({
  invoke: async () => ({ config: { general: { no_update: true, transport: mode } } }),
}));

const { useWebSocketStore: store } = await import("../../../src/store/WebsocketStore");
const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "store operation timed out");
    await Bun.sleep(1);
  }
};
store.setState({
  _auth_phase: "authenticated",
  _session: session as any,
  _all_data_initialized: true,
});
for (const name of ["provider", "sync", "trigger"] as const) await store.getState().connect(name);

// Mirrors AppProvider's automatic initialization, including synchronous store
// subscriptions that observe every intermediate state while switching.
const automatic = store.subscribe((state) => {
  if (state._auth_phase === "authenticated" && !state._all_data_initialized) void state.init();
});
const switching = store.getState().setTransportMode("websocket");
await Promise.resolve();
await store.getState().recoverTransport();
await switching;
await wait(() => !store.getState()._initiating);
assert.equal(
  starts,
  1,
  "initialization/recovery during the switch must not restart the just-launched backend"
);
assert.equal(store.getState()._auth_phase, "authenticated");
assert.deepEqual(Object.keys(store.getState().connections).sort(), ["provider", "sync", "trigger"]);
automatic();
const staleControl = controls[0];
assert.ok(staleControl, "WebSocket switch must have opened a real store control adapter");

// Suspend an old initialization, then finish a new native switch without a
// mounted component or probe calling init on its behalf.
store.setState({ _all_data_initialized: false });
holdNextStorage = true;
const staleInit = store.getState().init();
await wait(() => Boolean(releaseStorage));
const staleProvider = opened.get("provider")!;
holdSnapshots = true;
publishReady = false;
await store.getState().setTransportMode("pipe");
await wait(() => delayedSnapshots.length === 2);
staleControl.onSecureMessage({ type: "heartbeat", timestamp: 999999 });
assert.equal(
  store.getState()._heartbeat_time,
  0,
  "an old control cannot refresh the new connection's heartbeat"
);
staleControl.onSecureMessage({ type: "auth_revoked", pwd_epoch: 99 });
assert.equal(
  store.getState()._auth_phase,
  "authenticated",
  "an old control cannot revoke the new connection's authentication"
);
assert.equal(
  store.getState()._initiating,
  true,
  "a successful native switch must initialize after its switch guard is released"
);
releaseStorage!();
await staleInit;
assert.equal(
  store.getState()._initiating,
  true,
  "the old init's finally must not clear a newer generation's flag"
);
staleProvider.receive?.({ type: "status", status: { is_all_data_initialized: true } });
assert.equal(
  store.getState()._all_data_initialized,
  false,
  "stale callbacks must not announce a new backend ready"
);
holdSnapshots = false;
for (const release of delayedSnapshots.splice(0)) release();
opened.get("provider")!.receive?.({ type: "status", status: { is_all_data_initialized: true } });
await wait(() => !store.getState()._initiating);
assert.equal(starts, 2, "one explicit switch should start exactly one backend");
for (const name of ["provider", "sync", "trigger"] as const) store.getState().disconnect(name);
console.log("switch race regression passed");
