import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import {
  androidLocalHarnessFiles,
  androidLocalResults,
  localRestoration,
  validateAndroidLocal,
} from "./android-local-data.mjs";

assert.ok(
  process.argv[2] && process.argv[3],
  "Usage: node docs/scripts/publish-android-local.mjs RAW_RUN_DIRECTORY NATIVE_CHECKOUT"
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = path.resolve(process.argv[2]);
const native = path.resolve(process.argv[3]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (file) => readFileSync(path.join(root, file));
const normalized = (bytes) => bytes.toString().replaceAll("\r\n", "\n");
const hostBytes = readFileSync(path.join(directory, "run.json"));
const workerBytes = readFileSync(path.join(directory, "worker-result.json"));
const host = JSON.parse(hostBytes),
  worker = JSON.parse(workerBytes);
assert.equal(host.probe, false);
assert.equal(worker.probe, false);
assert.equal(host.success, true);
assert.equal(worker.success, true);
assert.equal(host.error, undefined);
assert.equal(host.cleanupError, undefined);
assert.equal(host.session, worker.session);
assert.equal(host.backendPid, worker.runtime.pid);
assert.equal(worker.runtime.process, "io.github.kiramei.baas_tauri.docs.x86:baas_backend");
assert.ok(worker.runtime.uid >= 10000);
assert.equal(host.systemProcessBefore, host.systemProcessAfter);
assert.equal(host.sharedShizukuBefore.length, 1);
assert.match(host.sharedShizukuBefore[0], /^shell\s+\d+\s+shizuku_server$/);
assert.deepEqual(host.restoration, localRestoration);
const currentHarness = Object.fromEntries(
  androidLocalHarnessFiles.map((file) => [file, digest(normalized(read(file)))])
);
assert.deepEqual(host.harness, currentHarness, "Measured harness changed");
const git = (args) => execFileSync("git", args, { cwd: native, windowsHide: true });
assert.equal(git(["rev-parse", "HEAD"]).toString().trim(), host.sourceRevision);
assert.equal(git(["status", "--porcelain"]).toString().trim(), "");
for (const [file, hash] of Object.entries(host.nativeSources)) {
  const current = normalized(readFileSync(path.join(native, file)));
  assert.equal(digest(current), hash);
  assert.equal(normalized(git(["show", host.sourceRevision + ":" + file])), current);
}
const apk = path.join(
  native,
  "src-tauri/gen/android/app/build/outputs/apk/x86_64/debug/app-x86_64-debug.apk"
);
assert.equal(digest(readFileSync(apk)), host.apkSha256);
const requirements = new AdmZip(
  new AdmZip(apk).readFile("assets/chaquopy/requirements-common.imy")
);
const pillowMetadata = requirements
  .getEntries()
  .filter((entry) => /^pillow-[^/]+\.dist-info\/METADATA$/.test(entry.entryName));
assert.equal(pillowMetadata.length, 1);
const pillowBytes = requirements.readFile(pillowMetadata[0]);
const apkPillowVersion = pillowBytes.toString().match(/^Version: ([^\r\n]+)$/m)?.[1];
assert.match(apkPillowVersion, /^\d+\.\d+\.\d+$/);
const device = JSON.parse(read("docs/public/benchmarks/device-current.json"));
assert.equal(host.targetApkSha256, device.targetApkSha256);
for (const [file, hash] of Object.entries(device.targetSourceFiles))
  assert.equal(digest(normalized(read(file))), hash);
const record = {
  schemaVersion: 1,
  measuredAt: host.startedAt,
  completedAt: host.finishedAt,
  probe: false,
  completed: true,
  verifiedEmbeddedProcess: true,
  sourceRevision: host.sourceRevision,
  apkSha256: host.apkSha256,
  targetApkSha256: host.targetApkSha256,
  nativeSources: host.nativeSources,
  harnessFiles: currentHarness,
  targetSources: device.targetSourceFiles,
  installedSources: worker.runtime.installedSources,
  adapterModule: worker.runtime.adapterModule,
  adapterCodeSha256: worker.runtime.adapterCodeSha256,
  entrypointOriginalSha256: host.entrypointOriginalSha256,
  entrypointInstrumentedSha256: host.entrypointInstrumentedSha256,
  environment: {
    ...host.environment,
    python: worker.runtime.python,
    numpy: worker.runtime.numpy,
    pointerBits: worker.runtime.pointerBits,
    clock: worker.runtime.clock,
    screenshotIntervalSeconds: worker.runtime.screenshotIntervalSeconds,
    shizukuUid: 2000,
    apkPillowVersion,
    workload:
      "One emulator/session; no build or other benchmark started during sampling; unrelated host activity uncontrolled.",
  },
  methodology: worker.methodology,
  capture: worker.capture,
  control: worker.control,
  warmups: worker.warmups,
  failures: worker.failures,
  restoration: host.restoration,
  interpretation: {
    capture:
      "Production AndroidLocalScreenshot and production script Screenshot wrapper on a 1280x720 tagged native fixture. Script interval is 0.3 seconds after the previous wrapper call completes. Guard, frame verification, texture MSE and host coordination are outside API timing.",
    input:
      "Production Control wrapper. API return and sequential screenshot-confirmation endpoints share an on-device monotonic start. Confirmation starts polling after API return and includes PNG capture/decoding and barcode verification; it is not the first visible pixel or isolated input-dispatch latency.",
    source:
      "Native APK and five source files are checked against the isolated Git revision. Installed backend-file hashes describe the actual downloaded runtime; no full backend Git revision is inferred from the archive.",
    scope:
      "Synthetic fixture only; no game input or account task. Separate platform/runtime from desktop adapter measurements; not a universal speed ranking, game FPS or business-task acceptance.",
    quantile:
      "Sorted zero-based index floor(n*p), capped at n-1. All warm-ups and successful formal samples retained; no outlier removal, forced GC, confidence interval or cross-device inference.",
  },
};
record.results = androidLocalResults(record);
record.publication = {
  hostRecordSha256: digest(hostBytes),
  workerRecordSha256: digest(workerBytes),
  publisherSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
  calculationSha256: digest(read("docs/scripts/android-local-data.mjs")),
  nativeGitObjectsVerified: true,
  localApkVerified: true,
  targetSourcesVerified: true,
  apkPillowMetadata: {
    entry: "assets/chaquopy/requirements-common.imy!" + pillowMetadata[0].entryName,
    sha256: digest(pillowBytes),
  },
};
validateAndroidLocal(record, currentHarness);
const bytes = JSON.stringify(record, null, 2) + "\n";
writeFileSync(path.join(root, "docs/public/benchmarks/android-local-current.json"), bytes);
writeFileSync(
  path.join(root, "docs/public/benchmarks/android-local-summary.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      recordSha256: digest(bytes),
      ...record.results,
    },
    null,
    2
  ) + "\n"
);
console.log(
  JSON.stringify({
    capture: record.capture.length,
    control: record.control.length,
    warmups: record.warmups.length,
    restored: true,
    published: true,
    results: record.results,
  })
);
