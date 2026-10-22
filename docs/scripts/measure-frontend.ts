import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBinaryRequest } from "../../src/transport/pipe/protocol";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rounds = 100;
const warmup = 5;
const summarize = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    samplesMs: samples,
  };
};

const encoding = [1024, 65536, 1048576].map((payloadBytes) => {
  const payload = Uint8Array.from({ length: payloadBytes }, (_, index) => index % 256);
  const samples = { legacy: [] as number[], raw: [] as number[] };
  const sizes = { legacy: 0, raw: 0 };
  const operations = {
    legacy: () =>
      JSON.stringify({ channel: "remote", name: "remote-screen", payload: Array.from(payload) }),
    raw: () => encodeBinaryRequest("remote", "remote-screen", payload),
  };
  assert.deepEqual(JSON.parse(operations.legacy()).payload, Array.from(payload));
  assert.equal(operations.raw().byteLength, payloadBytes + 21);
  for (let round = -warmup; round < rounds; round++) {
    const order: (keyof typeof samples)[] = round % 2 === 0 ? ["legacy", "raw"] : ["raw", "legacy"];
    for (const key of order) {
      const started = performance.now();
      const result = operations[key]();
      const duration = performance.now() - started;
      sizes[key] = typeof result === "string" ? result.length : result.byteLength;
      if (round >= 0) samples[key].push(duration);
    }
  }
  return {
    payloadBytes,
    rounds,
    warmup,
    legacy: { ...summarize(samples.legacy), encodedBytes: sizes.legacy },
    raw: { ...summarize(samples.raw), encodedBytes: sizes.raw },
  };
});

const logBatching = JSON.parse(
  execFileSync(process.execPath, ["scripts/benchmark-log-batching.ts", "10000", "15"], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
  })
);
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
  environment: {
    os: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    runtime: `Bun ${Bun.version}`,
  },
  method: {
    encoding:
      "5 warm-ups then 100 sequential samples per method; alternating method order; quantile uses zero-based sorted index floor(n*p), capped at n-1; timer performance.now; no forced GC; ASCII payload; JSON length equals UTF-8 bytes for this workload",
    logs: "15 rounds; alternating order; identical rows asserted by the production benchmark; batch size 256",
    scope:
      "JavaScript request encoding and store preparation only. Excludes OS IPC, Rust, Python, WebView IPC, React rendering, screenshot/recognition and game execution. Single-machine descriptive results; no confidence interval or universal speedup claim.",
  },
  encoding,
  logBatching,
};
const destination = path.join(repo, "docs/public/benchmarks/frontend-current.json");
mkdirSync(path.dirname(destination), { recursive: true });
writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      destination,
      environment: report.environment,
      encoding: encoding.map(({ payloadBytes, legacy, raw }) => ({
        payloadBytes,
        legacyP50: legacy.p50Ms,
        rawP50: raw.p50Ms,
      })),
      logMedianMs: { before: logBatching.before.medianMs, after: logBatching.after.medianMs },
    },
    null,
    2
  )
);
