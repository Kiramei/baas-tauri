import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readPublishedMedia } from "../scripts/published-media.mjs";
import record from "../public/benchmarks/device-current.json";
import summary from "../evidence/device-summary.json";
import capture from "../evidence/device-target-capture.json";
import chartValidation from "../evidence/device-chart-validation.json";
import environmentAudit from "../public/benchmarks/device-environment-audit.json";
import { summarizeDevice, validateDevicePublication } from "../scripts/device-benchmark-data.mjs";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const root = new URL("../../", import.meta.url);

test("device charts recompute from every balanced raw sample and share its digest", () => {
  validateDevicePublication(record);
  expect(record.results).toEqual(summarizeDevice(record));
  expect(summary.results).toEqual(record.results);
  expect(summary.rawRecordSha256).toBe(
    hash(readFileSync(new URL("docs/public/benchmarks/device-current.json", root)))
  );
  expect(record.captureBlocks.flatMap((block) => block.samples)).toHaveLength(800);
  expect(record.controlBlocks.flatMap((block) => block.samples)).toHaveLength(576);
  expect(
    [...record.captureBlocks, ...record.controlBlocks].flatMap((block) => block.warmups)
  ).toHaveLength(304);
});

test("device evidence is tied to the measured harness, target and pinned source reference", () => {
  expect(record.harnessSha256).toBe(
    hash(readFileSync(new URL("docs/scripts/measure-device.py", root)))
  );
  expect(record.demoInspectorSha256).toBe(
    hash(readFileSync(new URL("docs/scripts/inspect-device-demo.mjs", root)))
  );
  expect(record.sourceReference.revision).toBe(record.backendRevision);
  expect(Object.keys(record.sourceReference.gitBlobSha256).sort()).toEqual(
    Object.keys(record.sourceFiles).sort()
  );
  expect(Object.keys(record.sourceFiles)).toHaveLength(14);
  for (const [file, digest] of Object.entries(record.targetSourceFiles))
    expect(hash(readFileSync(new URL(file, root)))).toBe(digest);
  expect(readPublishedMedia(capture.file, capture.sha256).record.changedVisiblePixels).toBe(0);
  expect(capture.targetApkSha256).toBe(record.targetApkSha256);
  expect(capture.demoRestored).toBe(true);
  expect(capture.dimensions).toEqual([1280, 720]);
  expect(chartValidation.rawRecordSha256).toBe(summary.rawRecordSha256);
  expect(chartValidation.cases).toHaveLength(16);
  expect(chartValidation.cases.every((entry) => entry.passed)).toBe(true);
  expect(environmentAudit.rawRecordSha256).toBe(summary.rawRecordSha256);
  expect(Date.parse(environmentAudit.checkedAt)).toBeGreaterThan(Date.parse(record.finishedAt));
  expect(environmentAudit.nemuSdk.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(environmentAudit.scope).toContain("Post-run");
});

test("publication rejects missing samples, altered order, invalid inputs and unrestored state", () => {
  const variants = [
    (copy: any) => copy.captureBlocks[0].samples.pop(),
    (copy: any) => copy.controlBlocks[0].samples.pop(),
    (copy: any) => (copy.captureBlocks[0].method = "nemu"),
    (copy: any) => (copy.controlBlocks[0].samples[0].visibleMs = -1),
    (copy: any) => (copy.controlBlocks[0].samples[0].target.inputs += 1),
    (copy: any) => (copy.controlBlocks[0].samples[0].target.durationMs += 1),
    (copy: any) => (copy.cleanup.sharedPackagesUnchanged = false),
    (copy: any) => (copy.after.runningSessions = 1),
    (copy: any) => (copy.after.taskSelections[0].enabled = 1),
    (copy: any) => (copy.results.capture[0].api.p50Ms += 10),
  ];
  for (const mutate of variants) {
    const copy = structuredClone(record);
    mutate(copy);
    expect(() => validateDevicePublication(copy)).toThrow();
  }
});

test("failed attempts are retained and counted without becoming successful timing samples", () => {
  const copy: any = structuredClone(record);
  delete copy.results;
  copy.captureBlocks[0].samples[0] = {
    elapsedMs: 10,
    failure: { type: "ValueError", reason: "stale-target-token" },
  };
  validateDevicePublication(copy);
  const result = summarizeDevice(copy).capture.find(
    (row: any) => row.scenario === "static" && row.method === "adb"
  );
  expect(result).toMatchObject({ attempted: 100, succeeded: 99, failed: 1 });
  expect(result.api.count).toBe(99);
});

test("public device data excludes private diagnostics and the UI imports only its compact summary", () => {
  const text = JSON.stringify(record);
  expect(text).not.toMatch(
    /WorkSpace|\.codex_tmp|ginstance|agentLogTail|127\.0\.0\.1:\d+|[a-z]:[\\/]/i
  );
  const component = readFileSync(new URL("docs/components/DeviceBenchmark.tsx", root), "utf8");
  expect(component).toContain("@/evidence/device-summary.json");
  expect(component).not.toContain("device-current.json");
  for (const locale of ["en", "zh"]) {
    const page = readFileSync(
      new URL(`docs/content/docs/${locale}/reference/performance.mdx`, root),
      "utf8"
    );
    expect(page).toContain(`<DeviceBenchmark locale="${locale}" kind="capture" />`);
    expect(page).toContain(`<DeviceBenchmark locale="${locale}" kind="control" />`);
    expect(page).toContain("/benchmarks/device-current.json");
  }
});
