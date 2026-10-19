import assert from "node:assert/strict";
import { mock } from "bun:test";

delete process.env.VITE_BAAS_DOCS_URL;
delete process.env.VITE_BAAS_WIKI_URL;
const browserCalls: unknown[][] = [];
const nativeCalls: string[] = [];
const nativeState: { failure?: Error } = {};
Object.assign(globalThis, {
  __WITH_TAURI__: false,
  __WITH_ANDROID__: false,
  window: {
    open: (...args: unknown[]) => browserCalls.push(args),
  },
});
mock.module("@tauri-apps/plugin-opener", () => ({
  openUrl: async (url: string) => {
    if (nativeState.failure) throw nativeState.failure;
    nativeCalls.push(url);
  },
}));
const { DOCUMENTATION_URL, openDocumentation } = await import("../../../src/shared/Documentation");
assert.equal(DOCUMENTATION_URL, "https://baas.kiramei.cn");

const webOpening = openDocumentation();
// Browser opening must happen during the click's user activation, before any await.
assert.deepEqual(browserCalls, [[DOCUMENTATION_URL, "_blank", "noopener,noreferrer"]]);
await webOpening;
assert.deepEqual(nativeCalls, []);

Object.assign(globalThis, { __WITH_TAURI__: true });
await openDocumentation();
assert.deepEqual(nativeCalls, [DOCUMENTATION_URL]);
assert.equal(browserCalls.length, 1);

Object.assign(globalThis, { __WITH_ANDROID__: true });
await openDocumentation();
assert.deepEqual(nativeCalls, [DOCUMENTATION_URL, DOCUMENTATION_URL]);
assert.equal(browserCalls.length, 1);

nativeState.failure = new Error("system browser unavailable");
await assert.rejects(openDocumentation(), nativeState.failure);
assert.equal(browserCalls.length, 1, "A native failure must not fall back to an embedded popup");
