import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessFiles, validatePayloadBenchmark } from "./native-payload-data.mjs";

assert.ok(
  process.argv[2] && process.argv[3] && process.argv[4],
  "Usage: node docs/scripts/publish-native-payload.mjs RAW_REPORT PORTABLE_ROOT BACKEND_GIT_CHECKOUT"
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = realpathSync(process.argv[3]);
const backend = realpathSync(process.argv[4]);
const bytes = readFileSync(path.resolve(process.argv[2]));
const report = JSON.parse(bytes);
const digest = (value) => createHash("sha256").update(value).digest("hex");
validatePayloadBenchmark(
  report,
  Object.fromEntries(
    harnessFiles.map((file) => [file, digest(readFileSync(path.join(root, file)))])
  )
);
const manifest = JSON.parse(
  readFileSync(path.join(root, "docs/public/media/desktop/installer-manifest.json"))
);
assert.equal(report.sourceRevision, manifest.sourceRevision);
assert.equal(report.executableSha256, manifest.executableSha256);
assert.equal(digest(readFileSync(path.join(runtime, "baas-tauri.exe"))), report.executableSha256);
const files = {};
for (const [file, hash] of Object.entries(report.backendFiles)) {
  assert.ok(!file.includes("..") && !path.isAbsolute(file));
  const current = readFileSync(path.join(runtime, file));
  assert.equal(digest(current), hash, "Runtime source changed after measurement: " + file);
  const committed = execFileSync("git", ["show", `${report.backendRevision}:${file}`], {
    cwd: backend,
    windowsHide: true,
    encoding: "utf8",
  });
  const normalized = current.toString("utf8").replaceAll("\r\n", "\n");
  assert.equal(
    normalized,
    committed.replaceAll("\r\n", "\n"),
    "Backend revision mismatch: " + file
  );
  files[file] = {
    runtimeSha256: hash,
    normalizedGitSha256: digest(normalized),
    matchesRevision: true,
  };
}
report.publication = {
  rawRecordSha256: digest(bytes),
  publisherSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
  backendSourceVerification: {
    revision: report.backendRevision,
    files,
    comparison:
      "Runtime bytes match the measured hashes; UTF-8 sources match Git objects after CRLF/LF normalization.",
  },
};
validatePayloadBenchmark(report);
const publishedBytes = JSON.stringify(report, null, 2) + "\n";
writeFileSync(
  path.join(root, "docs/public/benchmarks/native-payload-current.json"),
  publishedBytes
);
writeFileSync(
  path.join(root, "docs/public/benchmarks/native-payload-summary.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      recordSha256: digest(publishedBytes),
      results: report.results.map((row) => ({
        ...row,
        decodedConfigJsonBytes: report.blocks.find(
          (block) => block.payloadBytes === row.payloadBytes
        ).expectedConfigJsonBytes,
      })),
    },
    null,
    2
  ) + "\n"
);
console.log(
  JSON.stringify({
    measured: report.results.reduce((sum, row) => sum + row.count, 0),
    warmup: report.blocks.reduce((sum, row) => sum + row.warmupMs.length, 0),
    verifiedBackendFiles: Object.keys(files).length,
    completed: report.completed,
    restored: report.restored,
  })
);
