import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { summarize, transportOrders } from "./benchmark-statistics.mjs";

export const payloadSizes = [1024, 65536, 1048576];
export const payloadField = "_docs_benchmark_payload";
export const blockField = "_docs_benchmark_block";
export const payloadOrders = Array.from({ length: 6 }, (_, round) =>
  payloadSizes.map((_, index) => payloadSizes[(index + round) % payloadSizes.length])
);
export const harnessFiles = [
  "docs/scripts/measure-native-payload.mjs",
  "docs/scripts/native-payload-browser.mjs",
  "docs/scripts/native-payload-data.mjs",
  "docs/scripts/benchmark-statistics.mjs",
];
export function payloadText(bytes) {
  assert.ok(payloadSizes.includes(bytes));
  const pattern = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
  return pattern.repeat(Math.ceil(bytes / pattern.length)).slice(0, bytes);
}
export function canonical(value) {
  return JSON.stringify(value, function (_, item) {
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item;
  });
}
export function payloadResults(blocks) {
  return payloadSizes.flatMap((payloadBytes) =>
    ["websocket", "pipe", "shm"].map((mode) => {
      const rows = blocks.filter((row) => row.mode === mode && row.payloadBytes === payloadBytes);
      return {
        mode,
        payloadBytes,
        ...summarize(rows.flatMap((row) => row.samplesMs)),
        blockMeans: summarize(rows.flatMap((row) => row.blockMeansMs)),
        failedAttempts: rows.reduce((total, row) => total + row.failures.length, 0),
      };
    })
  );
}
export function validatePayloadBenchmark(report, currentHashes) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.probe, false);
  assert.equal(report.completed, true);
  assert.equal(report.restored, true);
  assert.deepEqual(report.restoration, {
    configBytes: true,
    eventBytes: true,
    storeConfig: true,
    storeEvents: true,
    originalMode: true,
    ready: true,
    idle: true,
  });
  for (const key of ["sourceRevision", "backendRevision"])
    assert.match(report[key], /^[a-f0-9]{40}$/);
  for (const key of ["executableSha256", "baselineConfigSha256", "baselineEventsSha256"])
    assert.match(report[key], /^[a-f0-9]{64}$/);
  assert.ok(Object.keys(report.backendFiles).length >= 10);
  for (const hash of Object.values(report.backendFiles)) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    report.payloads,
    payloadSizes.map((bytes) => ({
      bytes,
      sha256: createHash("sha256").update(payloadText(bytes)).digest("hex"),
    }))
  );
  assert.deepEqual(Object.keys(report.harnessFiles).sort(), [...harnessFiles].sort());
  for (const hash of Object.values(report.harnessFiles)) assert.match(hash, /^[a-f0-9]{64}$/);
  if (currentHashes)
    assert.deepEqual(report.harnessFiles, currentHashes, "Harness changed after measurement");
  assert.deepEqual(report.method.orders, transportOrders);
  assert.deepEqual(report.method.payloadOrders, payloadOrders);
  assert.equal(report.method.samplesPerBlock, 100);
  assert.equal(report.method.warmupPerBlock, 20);
  assert.equal(report.method.blockSize, 20);
  assert.equal(report.method.concurrency, 1);
  assert.ok(report.environment.webView.timerObservedMinimumMs > 0);
  assert.equal(report.blocks.length, 54);
  const expected = transportOrders.flatMap((order, round) =>
    order.flatMap((mode) =>
      payloadOrders[round].map((payloadBytes) => ({ round, mode, payloadBytes }))
    )
  );
  for (const [index, row] of report.blocks.entries()) {
    assert.deepEqual(
      { round: row.round, mode: row.mode, payloadBytes: row.payloadBytes },
      expected[index]
    );
    assert.equal(row.finalMode, row.mode);
    assert.equal(row.finalReady, true);
    assert.deepEqual(row.channels, ["provider", "sync", "trigger"]);
    assert.equal(row.samplesMs.length, 100);
    assert.equal(row.warmupMs.length, 20);
    assert.equal(row.blockMeansMs.length, 5);
    assert.equal(row.validated, 120);
    assert.equal(row.unexpectedUpdates, 0);
    assert.deepEqual(row.failures, []);
    assert.deepEqual(row.decodedConfigJsonBytes, [row.expectedConfigJsonBytes]);
    assert.ok(row.expectedConfigJsonBytes > row.payloadBytes);
    summarize(row.samplesMs);
    summarize(row.warmupMs);
    summarize(row.blockMeansMs);
    assert.ok(Number.isFinite(row.readinessMs) && row.readinessMs > 0);
  }
  for (const size of payloadSizes) {
    const sizes = report.blocks
      .filter((row) => row.payloadBytes === size)
      .map((row) => row.expectedConfigJsonBytes);
    assert.equal(new Set(sizes).size, 1, "Decoded response sizes differ across carriers");
  }
  assert.deepEqual(report.results, payloadResults(report.blocks));
  assert.equal(
    report.results.reduce((sum, row) => sum + row.count, 0),
    5400
  );
  assert.doesNotMatch(
    JSON.stringify(report),
    /[a-z]:[\\/]+(?:workspace|users)[\\/]|\.codex_tmp|\bbaas-shm-[\w-]+|\b127\.0\.0\.1:\d+|"(?:password|token|masterSecret|resumeSecret|config_id)"/i
  );
  return report;
}
