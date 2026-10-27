import assert from "node:assert/strict";
import { mock } from "bun:test";

Object.assign(globalThis, { __WITH_TAURI__: false, __WITH_ANDROID__: false, __WITH_WEBUI__: true });
mock.module("../../../src/shared/StorageManager.ts", () => ({
  default: { get: () => null, set() {}, init: async () => {} },
}));
const { useWebSocketStore: store } = await import("../../../src/store/WebsocketStore");
const sent: string[] = [];
let resolveRequest: (() => void) | undefined;
store.setState({
  transportMode: "websocket",
  _control: {
    resetKey: (value: string) => {
      sent.push(value);
      return new Promise<void>((resolve) => {
        resolveRequest = resolve;
      });
    },
  } as any,
  _session: { sessionId: "fixture-session" } as any,
});

for (const phase of [
  "idle",
  "control_connecting",
  "server_verified",
  "waiting_password",
  "resuming",
  "initializing",
  "authenticating",
  "revoked",
] as const) {
  store.setState({ _auth_phase: phase });
  await assert.rejects(store.getState().resetKey("fixture-new-key"), /authenticated/);
}
assert.equal(sent.length, 0, "no pre-authentication state sends a Key reset");
store.setState({ _auth_phase: "authenticated" });
await assert.rejects(store.getState().resetKey("   "), /required/);
for (const mode of ["pipe", "shm"] as const) {
  store.setState({ transportMode: mode });
  await assert.rejects(store.getState().resetKey("fixture-new-key"), /authenticated WebUI/);
}
store.setState({ transportMode: "websocket" });
const session = store.getState()._session;
store.setState({ _session: null });
await assert.rejects(store.getState().resetKey("fixture-new-key"), /authenticated/);
store.setState({ _session: session });
for (const native of ["__WITH_TAURI__", "__WITH_ANDROID__"]) {
  (globalThis as any)[native] = true;
  await assert.rejects(store.getState().resetKey("fixture-new-key"), /authenticated WebUI/);
  (globalThis as any)[native] = false;
}
let capability = false;
let revokeDuringCheck = false;
globalThis.fetch = (async () => {
  if (revokeDuringCheck) store.setState({ _auth_phase: "revoked" });
  return new Response(JSON.stringify({ auth: { key_reset_supported: capability } }), {
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;
await assert.rejects(store.getState().resetKey("fixture-new-key"));
assert.equal(sent.length, 0, "old backends cannot receive an unconfirmable Key change");
capability = true;
revokeDuringCheck = true;
await assert.rejects(store.getState().resetKey("fixture-new-key"), /session changed/);
assert.equal(sent.length, 0, "revocation during capability discovery cancels the request");
revokeDuringCheck = false;
store.setState({ _auth_phase: "authenticated" });
let confirmed = false;
const reset = store
  .getState()
  .resetKey("fixture-new-key")
  .then(() => {
    confirmed = true;
  });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(confirmed, false, "sending does not claim a successful rotation");
assert.deepEqual(sent, ["fixture-new-key"]);
resolveRequest!();
await reset;
assert.equal(confirmed, true);
assert.equal(store.getState()._session, session, "revocation follows the server notification");
