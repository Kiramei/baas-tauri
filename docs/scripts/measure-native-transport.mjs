import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarize, transportOrders } from "./benchmark-statistics.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assert.ok(
  process.argv[2] && process.argv[3],
  "Usage: node docs/scripts/measure-native-transport.mjs CDP_PORT DISPOSABLE_PORTABLE_ROOT"
);
const runtime = realpathSync(process.argv[3]);
const captures = JSON.parse(
  readFileSync(path.join(root, "docs/public/media/desktop/installer-manifest.json"), "utf8")
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(digest(readFileSync(path.join(runtime, "baas-tauri.exe"))), captures.executableSha256);
const profiles = readdirSync(path.join(runtime, "config"), { withFileTypes: true }).filter(
  (file) => file.isDirectory() && existsSync(path.join(runtime, "config", file.name, "event.json"))
);
assert.equal(
  profiles.length,
  1,
  "Use a disposable root containing exactly one disabled demo profile"
);
const events = JSON.parse(
  readFileSync(path.join(runtime, "config", profiles[0].name, "event.json"), "utf8")
);
assert.equal(events.length, 26);
assert.ok(events.every((event) => event.enabled === false));
const output = path.join(root, ".cache/docs-benchmarks/native-transport.json");
mkdirSync(path.dirname(output), { recursive: true });
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  sourceRevision: captures.sourceRevision,
  backendRevision: "d0a86a089068766ff53682b501b90bee99857a71",
  executableSha256: captures.executableSha256,
  harnessFiles: Object.fromEntries(
    ["docs/scripts/measure-native-transport.mjs", "docs/scripts/benchmark-statistics.mjs"].map(
      (file) => [file, digest(readFileSync(path.join(root, file)))]
    )
  ),
  environment: {
    os: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0].model.trim(),
    logicalCpus: os.cpus().length,
    memoryGiB: Math.floor(os.totalmem() / 1024 ** 3),
    harness: "Node.js " + process.versions.node,
    concurrentWorkloads:
      "No build or other benchmark started by this harness; other host activity is not controlled.",
  },
  method: {
    workload:
      "Actual production store.trigger(status), one demo profile, no running tasks; production callback must return an idle status object.",
    scope:
      "WebView JavaScript before trigger to production callback entry; includes request preparation, selected carrier, Rust/WebView bridge where applicable, Python handler, JSON and encrypted SecureWebSocket for WebSocket. Excludes CDP round trips, transport restart, game, screenshot and rendering.",
    samplesPerBlock: 300,
    warmupPerBlock: 50,
    settleMs: 1000,
    blockSize: 50,
    concurrency: 1,
    orders: transportOrders,
    quantile:
      "Zero-based sorted index floor(n*p), capped at n-1; successful samples only; failed attempts retained separately; no outlier removal or forced GC.",
    blockMean:
      "Elapsed time for 50 consecutive calls divided by successful calls; includes callback validation and loop overhead. A block with failures has no block mean.",
    readiness:
      "From calling setTransportMode to authenticated and all data initialized. Includes stopping the previous mode, process restart, authentication and sync with warm OS caches; not cold application startup.",
    inference:
      "Single host/session; six order-balanced blocks per mode, no confidence interval or universal speedup claim. Timer-quantized individual samples must not be used for zero-denominator speedup ratios.",
  },
  backendFiles: {},
  rounds: [],
  completed: false,
  restored: false,
};
for (const file of [
  "main.service.py",
  "service/api/commands.py",
  "service/channels/trigger.py",
  "service/transport/pipe_endpoint.py",
  "service/transport/shm_endpoint.py",
  "service/transport/websocket_endpoint.py",
  "service/auth/channels.py",
])
  report.backendFiles[file] = digest(readFileSync(path.join(runtime, file)));
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
const browser = await chromium.connectOverCDP("http://127.0.0.1:" + process.argv[2], {
  noDefaults: true,
});
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url() === "http://tauri.localhost/");
assert.ok(page, "Expected the isolated native release WebView");
let originalMode;
try {
  const storage = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("updater_get_storage_state")
  );
  assert.equal(storage.portable, true);
  assert.equal(
    realpathSync(path.dirname(storage.storageFilePath)),
    runtime,
    "CDP points at a different runtime; do not restart it"
  );
  const startup = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("updater_get_startup_state")
  );
  assert.equal(startup.config.general.no_update, true);
  report.environment.python = execFileSync(startup.config.python.runtime_path, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const initial = await page.evaluate(async () => {
    for (const script of document.querySelectorAll("script[type=module][src]")) {
      const module = await import(script.src);
      for (const value of Object.values(module)) {
        if (typeof value?.getState !== "function") continue;
        const state = value.getState();
        if (typeof state?.trigger === "function" && typeof state?.setTransportMode === "function")
          window.__docsBenchmarkStore = value;
      }
    }
    const store = window.__docsBenchmarkStore;
    if (!store)
      throw new Error("The production module does not export its existing connection store");
    const state = store.getState();
    if (!state._all_data_initialized || state._auth_phase !== "authenticated")
      throw new Error("Enter the isolated app Home page before measuring");
    if (Object.values(state.statusStore).some((status) => status.running))
      throw new Error("Tasks are running");
    if (Object.keys(state.configStore).length !== 1) throw new Error("Expected one demo profile");
    let previous = performance.now(),
      minimum = Infinity,
      ticks = 0;
    for (let index = 0; index < 200000; index++) {
      const current = performance.now();
      if (current > previous) {
        minimum = Math.min(minimum, current - previous);
        ticks++;
      }
      previous = current;
    }
    return {
      originalMode: state.transportMode,
      userAgent: navigator.userAgent,
      visibility: document.visibilityState,
      crossOriginIsolated,
      timerObservedMinimumMs: minimum,
      timerTicks: ticks,
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
    };
  });
  originalMode = initial.originalMode;
  report.environment.webView = initial;
  assert.equal(initial.visibility, "visible");
  for (let round = 0; round < transportOrders.length; round++) {
    for (const mode of transportOrders[round]) {
      const result = await page.evaluate(
        async ({ mode, round, method }) => {
          const store = window.__docsBenchmarkStore;
          const before = store.getState();
          if (Object.values(before.statusStore).some((status) => status.running))
            throw new Error("Tasks started unexpectedly");
          const fromMode = before.transportMode;
          const readyStarted = performance.now();
          await before.setTransportMode(mode);
          const deadline = performance.now() + 60000;
          while (
            !store.getState()._all_data_initialized ||
            store.getState()._auth_phase !== "authenticated"
          ) {
            if (performance.now() > deadline) throw new Error("Transport initialization timed out");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const readinessMs = performance.now() - readyStarted;
          await new Promise((resolve) => setTimeout(resolve, method.settleMs));
          let timestamp = Date.now();
          const callbackSizes = new Set();
          const outcome = {
            round,
            mode,
            fromMode,
            readinessMs,
            channels: Object.keys(store.getState().connections).sort(),
            samplesMs: [],
            failures: [],
            blockMeansMs: [],
            warmupFailures: [],
          };
          async function request() {
            timestamp = Math.max(timestamp + 1, Date.now());
            const currentTimestamp = timestamp;
            return await new Promise((resolve) => {
              const started = performance.now();
              const timer = setTimeout(() => {
                delete store.getState().pendingCallbacks[currentTimestamp];
                resolve({ ok: false, elapsedMs: performance.now() - started, reason: "timeout" });
              }, 10000);
              store
                .getState()
                .trigger(
                  { command: "status", payload: {}, timestamp: currentTimestamp },
                  (response) => {
                    const elapsedMs = performance.now() - started;
                    clearTimeout(timer);
                    const data = response?.data;
                    const valid =
                      response?.command === "status" &&
                      response?.status === "ok" &&
                      data &&
                      !Array.isArray(data) &&
                      typeof data === "object" &&
                      Object.values(data).every(
                        (status) => status && typeof status === "object" && status.running !== true
                      );
                    callbackSizes.add(new TextEncoder().encode(JSON.stringify(response)).length);
                    resolve({
                      ok: Boolean(valid),
                      elapsedMs,
                      reason: valid ? undefined : "non-idle-or-invalid-response",
                    });
                  }
                );
            });
          }
          for (let index = 0; index < method.warmupPerBlock; index++) {
            const sample = await request();
            if (!sample.ok) outcome.warmupFailures.push({ index, ...sample });
            if (!sample.ok) return outcome;
          }
          for (let block = 0; block < method.samplesPerBlock / method.blockSize; block++) {
            const started = performance.now();
            let successes = 0;
            for (let index = 0; index < method.blockSize; index++) {
              const sample = await request();
              if (sample.ok) {
                outcome.samplesMs.push(sample.elapsedMs);
                successes++;
              } else outcome.failures.push({ index: block * method.blockSize + index, ...sample });
              if (!sample.ok) return outcome;
            }
            outcome.blockMeansMs.push(
              successes === method.blockSize ? (performance.now() - started) / successes : null
            );
          }
          return {
            ...outcome,
            callbackJsonBytes: [...callbackSizes].sort((left, right) => left - right),
            finalReady: store.getState()._all_data_initialized,
            finalMode: store.getState().transportMode,
          };
        },
        { mode, round, method: report.method }
      );
      report.rounds.push(result);
      save();
      assert.equal(result.finalMode, mode);
      assert.equal(result.finalReady, true);
      assert.deepEqual(result.warmupFailures, [], "Warm-up failures retained in local evidence");
      assert.deepEqual(result.failures, [], "Measured failures retained in local evidence");
      console.log(
        JSON.stringify({
          round,
          mode,
          readinessMs: result.readinessMs,
          ...summarize(result.samplesMs),
        })
      );
    }
  }
  report.results = ["websocket", "pipe", "shm"].map((mode) => {
    const rounds = report.rounds.filter((round) => round.mode === mode);
    const samples = rounds.flatMap((round) => round.samplesMs);
    return {
      mode,
      ...summarize(samples),
      failedAttempts: rounds.reduce((sum, round) => sum + round.failures.length, 0),
      blockMeans: summarize(rounds.flatMap((round) => round.blockMeansMs)),
      readiness: summarize(rounds.map((round) => round.readinessMs)),
    };
  });
  report.completed = true;
} finally {
  try {
    if (originalMode) {
      await page.evaluate(async (mode) => {
        const store = window.__docsBenchmarkStore;
        if (Object.values(store.getState().statusStore).some((status) => status.running))
          throw new Error("Tasks started; do not stop them to restore the transport");
        await store.getState().setTransportMode(mode);
        const deadline = performance.now() + 60000;
        while (
          !store.getState()._all_data_initialized ||
          store.getState()._auth_phase !== "authenticated"
        ) {
          if (performance.now() > deadline)
            throw new Error("Original transport restoration timed out");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }, originalMode);
      report.restored = true;
    }
  } finally {
    save();
    await browser.close();
  }
}
console.log(
  JSON.stringify({
    completed: report.completed,
    restored: report.restored,
    results: report.results,
  })
);
