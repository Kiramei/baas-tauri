import assert from "node:assert/strict";
import { summarize } from "./benchmark-statistics.mjs";

export const deviceMethods = ["adb", "uiautomator2", "scrcpy", "nemu"];
export const deviceOrders = [
  ["adb", "uiautomator2", "nemu", "scrcpy"],
  ["uiautomator2", "scrcpy", "adb", "nemu"],
  ["scrcpy", "nemu", "uiautomator2", "adb"],
  ["nemu", "adb", "scrcpy", "uiautomator2"],
];
const finite = (value) => assert.ok(Number.isFinite(value) && value >= 0);
const stats = (values) => (values.length ? summarize(values) : null);

export function validateDeviceBlocks(record) {
  assert.equal(record.captureBlocks.length, 32);
  assert.equal(record.controlBlocks.length, 48);
  for (const [kind, scenarios, warmups, samples] of [
    ["capture", ["static", "animated"], 5, 25],
    ["control", ["click", "swipe", "long_click"], 3, 12],
  ]) {
    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      for (let round = 0; round < 4; round++) {
        const blocks = record[kind + "Blocks"].filter(
          (block) =>
            block[kind === "capture" ? "scene" : "action"] === scenario && block.round === round
        );
        assert.equal(blocks.length, 4);
        const expected = deviceOrders[(round + (kind === "control" ? scenarioIndex : 0)) % 4];
        assert.deepEqual(
          [...blocks].sort((a, b) => a.position - b.position).map((block) => block.method),
          expected
        );
        for (const block of blocks) {
          assert.equal(block.warmups.length, warmups);
          assert.equal(block.samples.length, samples);
          for (const sample of [...block.warmups, ...block.samples]) {
            if (sample.failure) {
              assert.equal(typeof sample.failure.type, "string");
              finite(sample.elapsedMs);
              continue;
            }
            finite(sample.apiMs);
            if (kind === "capture") {
              assert.equal(sample.frame.token, block.token);
              assert.ok(["BGR", "RGB"].includes(sample.frame.channelOrder));
              finite(sample.quality.mse);
              assert.ok(sample.quality.psnrDb === null || Number.isFinite(sample.quality.psnrDb));
            } else {
              finite(sample.visibleMs);
              assert.equal(sample.target.inputs, sample.beforeInputs + 1);
              assert.equal(sample.observedDurationMs, sample.target.durationMs);
              assert.ok(
                Math.abs(sample.target.travelPixels - (scenario === "swipe" ? 400 : 0)) <= 10
              );
            }
          }
        }
      }
    }
  }
}

export function summarizeDevice(record) {
  validateDeviceBlocks(record);
  const results = { capture: [], control: [] };
  for (const [kind, scenarios] of [
    ["capture", ["static", "animated"]],
    ["control", ["click", "swipe", "long_click"]],
  ]) {
    for (const scenario of scenarios) {
      for (const method of deviceMethods) {
        const blocks = record[kind + "Blocks"].filter(
          (block) =>
            block.method === method && block[kind === "capture" ? "scene" : "action"] === scenario
        );
        const all = blocks.flatMap((block) => block.samples);
        const valid = all.filter((sample) => !sample.failure);
        const result = {
          scenario,
          method,
          attempted: all.length,
          succeeded: valid.length,
          failed: all.length - valid.length,
          warmupFailed: blocks.flatMap((block) => block.warmups).filter((sample) => sample.failure)
            .length,
          api: stats(valid.map((sample) => sample.apiMs)),
          blockMeans: stats(
            blocks.flatMap((block) => {
              const samples = block.samples.filter((sample) => !sample.failure);
              return samples.length
                ? [samples.reduce((sum, sample) => sum + sample.apiMs, 0) / samples.length]
                : [];
            })
          ),
        };
        if (kind === "control") {
          result.visible = stats(valid.map((sample) => sample.visibleMs));
          result.pressDuration = stats(valid.map((sample) => sample.target.durationMs));
          const travel = stats(valid.map((sample) => sample.target.travelPixels));
          result.travelPixels = travel
            ? {
                p50: travel.p50Ms,
                p95: travel.p95Ms,
                minimum: travel.minimumMs,
                maximum: travel.maximumMs,
              }
            : null;
        } else {
          result.qualityMeanMse = valid.length
            ? valid.reduce((sum, sample) => sum + sample.quality.mse, 0) / valid.length
            : null;
          let duplicateFrames = 0;
          for (const block of blocks) {
            let previous = block.warmups.at(-1)?.frame?.frame;
            for (const sample of block.samples) {
              if (sample.failure) {
                previous = undefined;
                continue;
              }
              if (sample.frame.frame === previous) duplicateFrames++;
              previous = sample.frame.frame;
            }
          }
          result.duplicateFrames = duplicateFrames;
        }
        results[kind].push(result);
      }
    }
  }
  return results;
}

export function validateDevicePublication(record) {
  assert.equal(record.completed, true);
  for (const field of [
    "demoForeground",
    "agentRemoved",
    "scrcpySocketAbsent",
    "automationProcessesAbsent",
    "sharedPackagesUnchanged",
    "sharedFilesRestored",
  ])
    assert.equal(record.cleanup[field], true, "Unrestored device: " + field);
  assert.deepEqual(record.cleanup.errors, []);
  for (const state of [record.before, record.after]) {
    assert.equal(state.auth, "authenticated");
    assert.equal(state.ready, true);
    assert.equal(state.runningSessions, 0);
    assert.equal(state.autostartProfiles, 0);
    assert.equal(state.demoEnabledTasks, 0);
    assert.equal(state.demoTotalTasks, 26);
  }
  assert.deepEqual(record.after.taskSelections, record.before.taskSelections);
  assert.equal(record.after.profiles, record.before.profiles);
  assert.deepEqual(record.targetGeometry, [1280, 720]);
  assert.equal(record.agent.version, "0.10.0");
  assert.equal(record.agent.architecture, "386");
  assert.ok(record.captureProbes.every((probe) => probe.available));
  assert.ok(record.controlProbes.every((probe) => probe.available));
  validateDeviceBlocks(record);
  if (record.results)
    assert.deepEqual(
      record.results,
      summarizeDevice(record),
      "Device summaries do not match raw samples"
    );
}
