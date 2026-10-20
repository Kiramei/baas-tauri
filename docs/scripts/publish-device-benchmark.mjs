import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeDevice, validateDevicePublication } from "./device-benchmark-data.mjs";
import { summarize } from "./benchmark-statistics.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.resolve(
  root,
  process.argv[2] || ".cache/docs-benchmarks/device-measurement-second.json"
);
assert.ok(source.startsWith(path.join(root, ".cache") + path.sep));
const raw = JSON.parse(readFileSync(source, "utf8"));
validateDevicePublication(raw);
const digest = (file) =>
  createHash("sha256")
    .update(readFileSync(path.join(root, file)))
    .digest("hex");
assert.equal(
  raw.harnessSha256,
  digest("docs/scripts/measure-device.py"),
  "Measurement harness changed after the run"
);
assert.equal(raw.demoInspectorSha256, digest("docs/scripts/inspect-device-demo.mjs"));
for (const [file, hash] of Object.entries(raw.targetSourceFiles)) assert.equal(digest(file), hash);
const [sourceRepo, runtimeRoot] = process.argv.slice(3);
assert.ok(
  sourceRepo && runtimeRoot,
  "Pass the pinned backend Git repository and measured disposable runtime after the raw report path"
);
const sourceReference = {
  revision: raw.backendRevision,
  textComparison: "UTF-8 with CRLF normalized to LF",
  gitBlobSha256: {},
};
for (const [file, expected] of Object.entries(raw.sourceFiles)) {
  assert.match(file, /^(core\/device\/[\w/]+\.py|src\/scrcpy_bin\/scrcpy-server\.jar)$/);
  const blob = execFileSync("git", ["-C", sourceRepo, "show", raw.backendRevision + ":" + file], {
    windowsHide: true,
  });
  const actual = readFileSync(path.join(runtimeRoot, file));
  assert.equal(
    createHash("sha256").update(actual).digest("hex"),
    expected,
    "Runtime source changed: " + file
  );
  if (file.endsWith(".py"))
    assert.equal(
      actual.toString("utf8").replaceAll("\r\n", "\n"),
      blob.toString("utf8").replaceAll("\r\n", "\n")
    );
  else assert.ok(actual.equals(blob), "Binary differs from the pinned Git object: " + file);
  sourceReference.gitBlobSha256[file] = createHash("sha256").update(blob).digest("hex");
}
const safeSample = (sample) => {
  const allowed = [
    "apiMs",
    "elapsedMs",
    "frame",
    "quality",
    "beforeInputs",
    "visibleMs",
    "observedFrame",
    "observedDurationMs",
    "target",
  ];
  const output = Object.fromEntries(
    allowed.filter((key) => key in sample).map((key) => [key, sample[key]])
  );
  if (sample.failure)
    output.failure = {
      type: sample.failure.type,
      reason: /^[a-z]+(?:-[a-z]+)+$/.test(sample.failure.reason)
        ? sample.failure.reason
        : "adapter-exception",
    };
  return output;
};
const safeBlocks = (blocks) =>
  blocks.map((block) => ({
    ...Object.fromEntries(
      ["scene", "action", "round", "position", "method", "token", "initializeMs"]
        .filter((key) => key in block)
        .map((key) => [key, block[key]])
    ),
    warmups: block.warmups.map(safeSample),
    samples: block.samples.map(safeSample),
  }));
const published = {
  schemaVersion: 1,
  startedAt: raw.startedAt,
  finishedAt: raw.finishedAt,
  completed: true,
  scope:
    "Desktop production screenshot/control adapters against an independent native Android test target on one MuMu 15 instance; not a game, Android-local bridge or full task benchmark.",
  backendRevision: raw.backendRevision,
  harnessSha256: raw.harnessSha256,
  demoInspectorSha256: raw.demoInspectorSha256,
  sourceFiles: raw.sourceFiles,
  sourceReference,
  targetSourceFiles: raw.targetSourceFiles,
  targetApkSha256: raw.targetApkSha256,
  targetGeometry: raw.targetGeometry,
  environment: raw.environment,
  agent: raw.agent,
  sharedPackageHashes: raw.sharedPackageHashes,
  standardAgentScreenshot: raw.standardAgentScreenshot,
  methodology: raw.methodology,
  before: raw.before,
  after: raw.after,
  cleanup: raw.cleanup,
  captureProbes: raw.captureProbes.map((probe) => ({
    method: probe.method,
    available: probe.available,
    initializeMs: probe.initializeMs,
    readinessAttempts: probe.readinessAttempts,
    captureMs: probe.captureMs,
    frame: probe.frame,
  })),
  controlProbes: raw.controlProbes.map((probe) => ({
    method: probe.method,
    available: probe.available,
    clickApiMs: probe.clickApiMs,
    state: probe.state,
  })),
  captureBlocks: safeBlocks(raw.captureBlocks),
  controlBlocks: safeBlocks(raw.controlBlocks),
  observer: {
    decodeSamplesMs: raw.observer.decodeSamplesMs,
    decodeSummary: summarize(raw.observer.decodeSamplesMs),
    invalidFrames: raw.observer.failures ?? raw.observer.invalidFrames,
    distinctStates: raw.observer.distinctStates,
  },
};
published.results = summarizeDevice(published);
validateDevicePublication(published);
const output = JSON.stringify(published, null, 2) + "\n";
assert.ok(
  !/[a-z]:[\\/]|WorkSpace|\.codex_tmp|baas-shm-|ginstance|atx-agent version.*Device IP/i.test(
    output
  ),
  "Potential private runtime detail in published evidence"
);
writeFileSync(path.join(root, "docs/public/benchmarks/device-current.json"), output);
writeFileSync(
  path.join(root, "docs/evidence/device-summary.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      rawRecordSha256: createHash("sha256").update(output).digest("hex"),
      results: published.results,
    },
    null,
    2
  ) + "\n"
);
console.log(
  JSON.stringify(
    {
      captureSamples: published.captureBlocks.reduce((n, block) => n + block.samples.length, 0),
      controlSamples: published.controlBlocks.reduce((n, block) => n + block.samples.length, 0),
      results: published.results,
    },
    null,
    2
  )
);
