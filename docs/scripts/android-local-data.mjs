import assert from "node:assert/strict";
import { summarize } from "./benchmark-statistics.mjs";

export const androidLocalHarnessFiles = [
  "docs/scripts/measure-android-local.mjs",
  "docs/scripts/measure-android-local-worker.py",
  "docs/benchmarks/android-local/service-hook.py",
];
export const controlOrders = [
  ["click", "swipe", "long_click"],
  ["swipe", "long_click", "click"],
  ["long_click", "click", "swipe"],
  ["long_click", "swipe", "click"],
  ["swipe", "click", "long_click"],
  ["click", "long_click", "swipe"],
];
export const localRestoration = {
  entrypointRestored: true,
  configsUnchanged: true,
  eventsUnchanged: true,
  uiSettingsUnchanged: true,
  displayInactive: true,
  gameStopped: true,
  fixtureStopped: true,
  sharedShizukuServerUnchanged: true,
  systemProcessUnchanged: true,
  nativeWorktreeUnchanged: true,
};
const duration = (value) => assert.ok(Number.isSafeInteger(value) && value >= 0);
const counter = (value) => assert.ok(Number.isInteger(value) && value >= 0 && value <= 65535);
const hash = (value) => assert.match(value, /^[a-f0-9]{64}$/);

export function androidLocalResults(record) {
  return {
    capture: ["static", "animated"].flatMap((scenario) =>
      ["adapter", "script"].map((method) => {
        const rows = record.capture.filter(
          (row) => row.scenario === scenario && row.method === method
        );
        return {
          scenario,
          method,
          ...summarize(rows.map((row) => row.elapsedNs / 1e6)),
          repeatedFrames: rows.filter((row) => row.repeatedFrame).length,
          maximumTextureMse: Math.max(...rows.map((row) => row.mse)),
          failures: 0,
        };
      })
    ),
    control: ["click", "swipe", "long_click"].map((scenario) => {
      const rows = record.control.filter((row) => row.scenario === scenario);
      const travel = rows.map((row) => row.observedTravelPixels).sort((a, b) => a - b);
      return {
        scenario,
        api: summarize(rows.map((row) => row.apiElapsedNs / 1e6)),
        confirmed: summarize(rows.map((row) => row.visibleElapsedNs / 1e6)),
        hold: summarize(rows.map((row) => row.observedDurationMs)),
        travelPixels: {
          minimum: travel[0],
          p50: travel[Math.floor(travel.length / 2)],
          maximum: travel.at(-1),
        },
        failures: 0,
      };
    }),
  };
}

export function validateAndroidLocal(record, currentHarness) {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.probe, false);
  assert.equal(record.completed, true);
  assert.equal(record.verifiedEmbeddedProcess, true);
  assert.deepEqual(record.restoration, localRestoration);
  assert.deepEqual(record.failures, []);
  assert.match(record.sourceRevision, /^[a-f0-9]{40}$/);
  hash(record.apkSha256);
  hash(record.targetApkSha256);
  hash(record.adapterCodeSha256);
  hash(record.entrypointOriginalSha256);
  hash(record.entrypointInstrumentedSha256);
  for (const field of ["nativeSources", "harnessFiles", "installedSources", "targetSources"]) {
    assert.ok(Object.keys(record[field]).length >= (field === "nativeSources" ? 5 : 3));
    for (const [file, value] of Object.entries(record[field])) {
      assert.ok(!file.includes("..") && !file.startsWith("/") && !file.includes("\\"));
      hash(value);
    }
  }
  assert.deepEqual(Object.keys(record.harnessFiles).sort(), [...androidLocalHarnessFiles].sort());
  if (currentHarness)
    assert.deepEqual(record.harnessFiles, currentHarness, "Measured harness changed");
  assert.equal(record.environment.screenshotIntervalSeconds, 0.3);
  assert.equal(record.environment.shizukuUid, 2000);
  assert.equal(record.environment.pointerBits, 64);
  assert.equal(record.environment.apiLevel, 35);
  assert.ok(record.environment.clock.resolutionSeconds > 0);
  assert.equal(record.adapterModule, "android_backend.native_device");
  assert.deepEqual(record.methodology, {
    captureBlocks: 10,
    captureTrials: 10,
    captureWarmups: 2,
    controlBlocks: 24,
    controlTrials: 3,
    controlWarmups: 2,
    callsPerMethodAndScenario: 100,
    controlOrders,
    controlCallsPerScenario: 72,
    gestureDurationSeconds: 0.3,
    swipeRequestPixels: 400,
    inputObserver: "sequential production AndroidLocalScreenshot after API return",
    hostCoordinationTimed: false,
    fixtureSnapshotTimed: false,
    independentConnectionMethods: false,
    accountTasksStarted: false,
    gameInputSent: false,
  });
  assert.equal(record.capture.length, 400);
  assert.equal(record.control.length, 216);
  assert.equal(record.warmups.length, 86);
  assert.equal(record.warmups.filter((row) => row.kind === "capture").length, 80);
  assert.equal(record.warmups.filter((row) => row.kind === "control").length, 6);
  const expectedCapture = [];
  for (let block = 0; block < 10; block++) {
    const scenes = block % 2 === 0 ? ["static", "animated"] : ["animated", "static"];
    for (const scenario of scenes) {
      const methods =
        (block + Number(scenario === "animated")) % 2 === 0
          ? ["adapter", "script"]
          : ["script", "adapter"];
      for (const [position, method] of methods.entries()) {
        const warm = record.warmups.filter(
          (row) =>
            row.kind === "capture" &&
            row.block === block &&
            row.scenario === scenario &&
            row.method === method
        );
        assert.equal(warm.length, 2);
        let previous = warm.at(-1).frame;
        for (let trial = 0; trial < 10; trial++)
          expectedCapture.push({
            block,
            scenario,
            position,
            method,
            trial,
            previous: trial === 0 ? previous : null,
          });
      }
    }
  }
  for (const [ordinal, row] of record.capture.entries()) {
    const expected = expectedCapture[ordinal];
    assert.deepEqual(
      {
        block: row.block,
        scenario: row.scenario,
        position: row.position,
        method: row.method,
        trial: row.trial,
      },
      {
        block: expected.block,
        scenario: expected.scenario,
        position: expected.position,
        method: expected.method,
        trial: expected.trial,
      }
    );
    assert.equal(row.ordinal, ordinal);
    duration(row.elapsedNs);
    counter(row.frame);
    assert.equal(row.outputBytes, 1280 * 720 * 3);
    assert.ok(Number.isFinite(row.mse) && row.mse >= 0 && row.mse <= 1);
    assert.equal(
      row.repeatedFrame,
      row.frame === (row.trial === 0 ? expected.previous : record.capture[ordinal - 1].frame)
    );
    if (row.method === "adapter") assert.equal(row.scriptGapBeforeCallMs, null);
    else assert.ok(Number.isFinite(row.scriptGapBeforeCallMs) && row.scriptGapBeforeCallMs >= 0);
  }
  const expectedControl = [];
  for (let block = 0; block < 24; block++)
    for (const [position, scenario] of controlOrders[block % 6].entries())
      for (let trial = 0; trial < 3; trial++)
        expectedControl.push({ block, position, scenario, trial });
  for (const [ordinal, row] of record.control.entries()) {
    assert.equal(row.ordinal, ordinal);
    assert.deepEqual(
      { block: row.block, position: row.position, scenario: row.scenario, trial: row.trial },
      expectedControl[ordinal]
    );
    duration(row.apiElapsedNs);
    duration(row.visibleElapsedNs);
    assert.ok(row.visibleElapsedNs >= row.apiElapsedNs);
    counter(row.frame);
    assert.equal(row.inputs, ordinal + 7);
    assert.ok(Number.isInteger(row.polls) && row.polls > 0);
    assert.ok(row.observedDurationMs >= (row.scenario === "click" ? 25 : 200));
    assert.ok(row.observedDurationMs <= (row.scenario === "click" ? 200 : 600));
    assert.ok(
      row.scenario === "swipe"
        ? row.observedTravelPixels >= 380 && row.observedTravelPixels <= 420
        : row.observedTravelPixels <= 3
    );
  }
  for (const row of record.warmups) {
    if (row.kind === "capture") {
      duration(row.elapsedNs);
      counter(row.frame);
      assert.equal(row.outputBytes, 1280 * 720 * 3);
      assert.ok(row.mse >= 0 && row.mse <= 1);
    } else {
      assert.equal(row.kind, "control");
      duration(row.apiElapsedNs);
      duration(row.visibleElapsedNs);
    }
  }
  assert.deepEqual(record.results, androidLocalResults(record));
  assert.doesNotMatch(
    JSON.stringify(record),
    /[a-z]:[\\/]+(?:workspace|users)[\\/]|\/data\/user\/|\.codex_tmp|\b127\.0\.0\.1:\d+|"(?:password|token|masterSecret|resumeSecret|privateTraceback|pid|uid)"/i
  );
  return record;
}
