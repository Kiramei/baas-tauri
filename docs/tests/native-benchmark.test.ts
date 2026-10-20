import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import data from "../public/benchmarks/native-transport-current.json";
import captureProbe from "../evidence/device-capture-probe.json";
import { summarize, transportOrders } from "../scripts/benchmark-statistics.mjs";
import { validateNativeBenchmark } from "../scripts/validate-native-benchmark.mjs";

test("benchmark quantiles preserve zero samples, tails and the documented index rule", () => {
  const values = [10, 0, 1, 2];
  expect(summarize(values)).toEqual({
    count: 4,
    p50Ms: 2,
    p95Ms: 10,
    minimumMs: 0,
    maximumMs: 10,
    meanMs: 3.25,
    zeroSamples: 1,
  });
  expect(values).toEqual([10, 0, 1, 2]);
  for (const invalid of [[], [-1], [Infinity], [NaN]]) expect(() => summarize(invalid)).toThrow();
  expect(summarize([0]).p95Ms).toBe(0);
});

test("each native transport occupies every order position twice", () => {
  expect(new Set(transportOrders.map((order) => order.join(","))).size).toBe(6);
  for (const mode of ["websocket", "pipe", "shm"]) {
    for (let position = 0; position < 3; position++)
      expect(transportOrders.filter((order) => order[position] === mode)).toHaveLength(2);
  }
});

test("published native transport statistics recompute from all 5400 measured calls", () => {
  expect(validateNativeBenchmark(data)).toBe(data);
  expect(data.results.reduce((sum, result) => sum + result.count, 0)).toBe(5400);
  for (const [file, expected] of Object.entries(data.harnessFiles)) {
    const actual = createHash("sha256")
      .update(readFileSync(new URL("../../" + file, import.meta.url)))
      .digest("hex");
    expect(actual).toBe(expected);
  }
});

test("native evidence rejects missing samples, hidden failures, unequal outputs and edited summaries", () => {
  const missing = structuredClone(data);
  missing.rounds[0].samplesMs.pop();
  expect(() => validateNativeBenchmark(missing)).toThrow();
  const wrongSummary = structuredClone(data);
  wrongSummary.results[0].p95Ms += 1;
  expect(() => validateNativeBenchmark(wrongSummary)).toThrow();
  const unequal = structuredClone(data);
  unequal.rounds[0].callbackJsonBytes = [45];
  expect(() => validateNativeBenchmark(unequal)).toThrow();
  const notRestored = structuredClone(data);
  notRestored.restored = false;
  expect(() => validateNativeBenchmark(notRestored)).toThrow();
  const failed = structuredClone(data);
  (failed.rounds[0].failures as unknown[]).push({ reason: "timeout", elapsedMs: 10000 });
  expect(() => validateNativeBenchmark(failed)).toThrow();
  const changedHarness = structuredClone(data.harnessFiles);
  changedHarness["docs/scripts/measure-native-transport.mjs"] = "0".repeat(64);
  expect(() => validateNativeBenchmark(data, changedHarness)).toThrow(/Harness changed/);
  const missingProvenance = structuredClone(data);
  delete (missingProvenance as Partial<typeof data>).harnessFiles;
  expect(() => validateNativeBenchmark(missingProvenance)).toThrow();
});

test("capture probes stay separate from performance data and preserve the service mismatch", () => {
  expect(captureProbe.scope).toContain("Not a performance comparison");
  expect(captureProbe.fixtureRemoved).toBe(true);
  expect(captureProbe.inputsSent).toBe(0);
  expect(captureProbe.environment.installedApkSha256).toBe(
    captureProbe.targetApkSha256.toLowerCase()
  );
  expect(captureProbe.serviceDiagnostic.baasBridgeVersionConfirmed).toBe(true);
  expect(captureProbe.serviceDiagnostic.screenshotStatus).toBe(403);
  expect(captureProbe.serviceDiagnostic.credentialsReadOrSent).toBe(false);
  const passed = captureProbe.results.filter((result) => result.available);
  expect(passed.map((result) => result.method)).toEqual(["adb", "scrcpy", "nemu"]);
  for (const result of captureProbe.results) {
    expect(result).not.toHaveProperty("firstCaptureMs");
    expect(result).not.toHaveProperty("initializeMs");
    if (result.frame) {
      expect([result.frame.width, result.frame.height]).toEqual([720, 1280]);
      expect(result.frame.colorMeanAbsoluteError).toBeLessThanOrEqual(25);
    }
  }
});
