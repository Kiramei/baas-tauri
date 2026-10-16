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
  normalizeTransportMode: (mode: string) => mode === "websocket" ? "websocket" : "pipe",
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

const { useWebSocketStore } = await import("../../../src/store/WebsocketStore");
const { useGlobalLogStore } = await import("../../../src/store/GlobalLogStore");
useWebSocketStore.setState({ _auth_phase: "authenticated", init: async () => {} });
useGlobalLogStore.setState({ globalLogData: [] });

const row = (message: string) => ({
  scope: "global",
  time: "2026-10-15T12:00:00+00:00",
  level: "INFO",
  message,
});
const globalMessages = () => useGlobalLogStore.getState().globalLogData.map((entry) => entry.message);

await useWebSocketStore.getState().connect("provider");
await useWebSocketStore.getState().connect("sync");
const oldProvider = opened.get("provider")!;
const oldSync = opened.get("sync")!;

oldProvider.receive!({ type: "log", entry: row("received before sync disconnect") });
assert.deepEqual(globalMessages(), [], "live rows should still be buffered before recovery");

// This enters the real recovery loop and invalidates every business channel
// before any provider timer has had an opportunity to fire.
oldSync.close();
assert.deepEqual(
  globalMessages(),
  ["received before sync disconnect"],
  "invalidating another channel must commit already received provider rows"
);

for (let index = 0; index < 50; index += 1) await Promise.resolve();
const newProvider = opened.get("provider")!;
assert.notEqual(newProvider, oldProvider, "recovery should reopen the provider");
assert.equal(useWebSocketStore.getState().connections.provider, newProvider);

// A restarted backend can send an empty history snapshot; global history must
// still contain rows that arrived before the generation changed.
newProvider.receive!({ type: "logs_full", scopes: ["global"], entries: [] });
oldProvider.receive!({ type: "log", entry: row("stale provider row") });
newProvider.receive!({ type: "log", entry: row("fresh provider row") });
newProvider.close();
assert.deepEqual(globalMessages(), ["received before sync disconnect", "fresh provider row"]);

for (let index = 0; index < 50; index += 1) await Promise.resolve();
useWebSocketStore.getState().disconnect("provider");
useWebSocketStore.getState().disconnect("sync");
await Bun.sleep(25);
assert.deepEqual(globalMessages(), ["received before sync disconnect", "fresh provider row"]);
