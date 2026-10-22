import assert from "node:assert/strict";
import { summarize, transportOrders } from "./benchmark-statistics.mjs";

export function validateNativeBenchmark(report, currentHarnessFiles) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(
    report.completed,
    true,
    "Incomplete experiments must not be presented as a completed comparison"
  );
  assert.equal(report.restored, true);
  assert.deepEqual(Object.keys(report.harnessFiles).sort(), [
    "docs/scripts/benchmark-statistics.mjs",
    "docs/scripts/measure-native-transport.mjs",
  ]);
  for (const hash of Object.values(report.harnessFiles)) assert.match(hash, /^[a-f0-9]{64}$/);
  if (currentHarnessFiles)
    assert.deepEqual(
      report.harnessFiles,
      currentHarnessFiles,
      "Harness changed after measurement; preserve the old record and measure the new version"
    );
  assert.deepEqual(report.method.orders, transportOrders);
  assert.equal(report.method.samplesPerBlock, 300);
  assert.equal(report.method.warmupPerBlock, 50);
  assert.equal(report.method.blockSize, 50);
  assert.equal(report.method.concurrency, 1);
  assert.equal(report.rounds.length, 18);
  assert.ok(report.environment.webView.timerObservedMinimumMs > 0);
  assert.deepEqual(
    report.rounds.map((round) => round.mode),
    transportOrders.flat()
  );
  for (const [index, round] of report.rounds.entries()) {
    assert.equal(round.round, Math.floor(index / 3));
    assert.equal(round.finalMode, round.mode);
    assert.equal(round.finalReady, true);
    assert.deepEqual(round.channels, ["provider", "sync", "trigger"]);
    assert.equal(round.samplesMs.length, 300);
    assert.equal(round.blockMeansMs.length, 6);
    assert.deepEqual(round.failures, []);
    assert.deepEqual(round.warmupFailures, []);
    // The production callback has exactly command/data/status. With status=ok
    // and command=status, 44 bytes establishes the same empty data object.
    assert.deepEqual(round.callbackJsonBytes, [44]);
    summarize(round.samplesMs);
    summarize(round.blockMeansMs);
    assert.ok(Number.isFinite(round.readinessMs) && round.readinessMs > 0);
  }
  assert.equal(report.results.length, 3);
  for (const [index, mode] of ["websocket", "pipe", "shm"].entries()) {
    const rounds = report.rounds.filter((round) => round.mode === mode);
    const result = report.results[index];
    assert.equal(rounds.length, 6);
    assert.deepEqual(result, {
      mode,
      ...summarize(rounds.flatMap((round) => round.samplesMs)),
      failedAttempts: 0,
      blockMeans: summarize(rounds.flatMap((round) => round.blockMeansMs)),
      readiness: summarize(rounds.map((round) => round.readinessMs)),
    });
  }
  assert.doesNotMatch(
    JSON.stringify(report),
    /[a-z]:[\\/]+(?:workspace|users)[\\/]|\.codex_tmp|\bbaas-shm-[\w-]+|\b127\.0\.0\.1:\d+|"(?:password|token|masterSecret|resumeSecret|config_id)"/i
  );
  return report;
}
