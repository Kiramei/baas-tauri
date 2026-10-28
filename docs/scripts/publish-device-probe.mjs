import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) =>
  JSON.parse(readFileSync(path.join(root, file), "utf8").replace(/^\uFEFF/, ""));
const probe = read(".cache/docs-benchmarks/device-capture-probe.json");
const service = read(".cache/docs-benchmarks/device-service-diagnostic.json");
assert.equal(probe.fixtureRemoved, true);
assert.equal(probe.environment.ownedWebViewVerified, true);
assert.equal(probe.environment.installedApkSha256, probe.targetApkSha256.toLowerCase());
assert.deepEqual(
  probe.results.map((result) => result.method),
  ["adb", "uiautomator2", "scrcpy", "nemu"]
);
assert.equal(service.baasBridgeVersionConfirmed, true);
assert.equal(service.screenshotStatus, 403);
assert.equal(service.credentialsReadOrSent, false);
const result = {
  checkedAt: probe.checkedAt,
  scope:
    "One tagged-frame compatibility probe per adapter in the owned Android demo app. Not a performance comparison; initialization/first-call timings are deliberately omitted. The original local record is not a steady-state benchmark.",
  backendRevision: probe.backendRevision,
  targetApplicationId: probe.targetApplicationId,
  targetApkSha256: probe.targetApkSha256,
  environment: probe.environment,
  fixture: probe.fixture,
  fixtureRemoved: probe.fixtureRemoved,
  inputsSent: 0,
  results: probe.results.map(({ method, available, phase, frame, failure }) => ({
    method,
    available,
    phase,
    frame,
    failure,
  })),
  serviceDiagnostic: service,
  interpretation:
    "Stock desktop uiautomator2 reached Android BAAS's authenticated local bridge at device port 7912, not standard atx-agent. The bridge's unauthenticated version marker and direct-device 403 identify the mismatch. This does not establish an Android-version or uiautomator2 performance limit. A separate target and service ownership are required before comparison.",
};
assert.doesNotMatch(
  JSON.stringify(result),
  /[a-z]:[\\/]+(?:workspace|users)[\\/]|\.codex_tmp|"(?:password|token|serial)"\s*:\s*"/i
);
writeFileSync(
  path.join(root, "docs/evidence/device-capture-probe.json"),
  JSON.stringify(result, null, 2) + "\n"
);
console.log(
  JSON.stringify({
    frameChecksPassed: result.results.filter((result) => result.available).length,
    methods: result.results.length,
    fixtureRemoved: result.fixtureRemoved,
    stockUiautomator2ServiceMismatch: true,
  })
);
