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
import { transportOrders } from "./benchmark-statistics.mjs";
import {
  blockField,
  canonical,
  harnessFiles,
  payloadField,
  payloadOrders,
  payloadResults,
  payloadSizes,
  payloadText,
} from "./native-payload-data.mjs";
import {
  measurePayloadBlock,
  preparePayload,
  switchPayloadTransport,
} from "./native-payload-browser.mjs";

assert.ok(
  process.argv[2] && process.argv[3],
  "Usage: node docs/scripts/measure-native-payload.mjs CDP_PORT DISPOSABLE_PORTABLE_ROOT [--probe]"
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = realpathSync(process.argv[3]);
const probe = process.argv.includes("--probe");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const captures = JSON.parse(
  readFileSync(path.join(root, "docs/public/media/desktop/installer-manifest.json"), "utf8")
);
assert.equal(digest(readFileSync(path.join(runtime, "baas-tauri.exe"))), captures.executableSha256);
const ids = readdirSync(path.join(runtime, "config"), { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() && existsSync(path.join(runtime, "config", entry.name, "event.json"))
  )
  .map((entry) => entry.name);
assert.equal(ids.length, 1, "Only an isolated, single-profile demo root is supported");
const id = ids[0];
const configPath = path.join(runtime, "config", id, "config.json");
const eventPath = path.join(runtime, "config", id, "event.json");
const configBytes = readFileSync(configPath);
const eventBytes = readFileSync(eventPath);
const baseline = JSON.parse(configBytes);
const events = JSON.parse(eventBytes);
assert.equal(baseline.autostart, false);
assert.equal(events.length, 26);
assert.ok(events.every((event) => event.enabled === false));
assert.ok(!Object.hasOwn(baseline, payloadField) && !Object.hasOwn(baseline, blockField));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = path.join(
  root,
  `.cache/docs-benchmarks/native-payload-${probe ? "probe-" : ""}${stamp}.json`
);
const backup = output.replace(/\.json$/, "-baseline");
assert.ok(!existsSync(output) && !existsSync(backup));
mkdirSync(backup, { recursive: true });
writeFileSync(path.join(backup, "config.json"), configBytes);
writeFileSync(path.join(backup, "event.json"), eventBytes);
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  probe,
  completed: false,
  restored: false,
  sourceRevision: captures.sourceRevision,
  backendRevision: "d0a86a089068766ff53682b501b90bee99857a71",
  executableSha256: captures.executableSha256,
  harnessFiles: Object.fromEntries(
    harnessFiles.map((file) => [file, digest(readFileSync(path.join(root, file)))])
  ),
  backendFiles: {},
  baselineConfigSha256: digest(configBytes),
  baselineEventsSha256: digest(eventBytes),
  payloads: payloadSizes.map((bytes) => ({ bytes, sha256: digest(payloadText(bytes)) })),
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
      "Production sync pull(config) returning one complete demo config with a synthetic ASCII field of 1 KiB, 64 KiB or 1 MiB. No echo service or transport API replacement.",
    scope:
      "WebView immediately before production store.send to the first production configStore reference update. Includes request dispatch, selected carrier, Python cached snapshot deepcopy, JSON, authenticated encryption for WebSocket, Rust/WebView bridge where applicable and synchronous Store subscribers before this observer. Excludes CDP, configuration writes, connection restart, content validation and React rendering after notification.",
    correlation:
      "One outstanding pull on an otherwise idle config sync channel. Every reply must match the entire expected config; any extra config reference update outside a request aborts the block. The production protocol does not echo a pull request ID.",
    payload:
      "Repeating 64-character ASCII pattern; not a binary image, encrypted wire size or a raw carrier throughput test. Decoded full-config byte lengths include normal config fields and two synthetic fields.",
    samplesPerBlock: probe ? 3 : 100,
    warmupPerBlock: probe ? 2 : 20,
    blockSize: probe ? 3 : 20,
    concurrency: 1,
    orders: transportOrders,
    payloadOrders,
    quantile:
      "Zero-based sorted index floor(n*p), capped at n-1. No outlier removal or forced GC. All failures retained; publication requires a complete, failure-free run.",
    blockMean:
      "Elapsed time for 20 consecutive calls divided by 20; includes full-content validation and loop overhead, unlike the individual notification latency.",
    inference:
      "One Windows host/session, six order-balanced rounds per size and mode; descriptive statistics, no confidence interval or universal speedup claim. Endpoints differ from the small status-command benchmark.",
  },
  blocks: [],
  restoration: {},
};
for (const file of [
  "main.service.py",
  "service/channels/sync.py",
  "service/conf/manager.py",
  "service/conf/resources.py",
  "service/utils/diff.py",
  "service/auth/channels.py",
  "service/auth/crypto.py",
  "service/transport/pipe_endpoint.py",
  "service/transport/shm_endpoint.py",
  "service/transport/websocket_endpoint.py",
])
  report.backendFiles[file] = digest(readFileSync(path.join(runtime, file)));
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.connectOverCDP("http://127.0.0.1:" + process.argv[2], {
  noDefaults: true,
});
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url() === "http://tauri.localhost/");
let originalMode;
try {
  assert.ok(page, "Expected the existing isolated release WebView");
  const storage = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("updater_get_storage_state")
  );
  assert.equal(storage.portable, true);
  assert.equal(
    realpathSync(path.dirname(storage.storageFilePath)),
    runtime,
    "Refusing to modify a different runtime"
  );
  const startup = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("updater_get_startup_state")
  );
  assert.equal(startup.config.general.no_update, true);
  report.environment.python = execFileSync(startup.config.python.runtime_path, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const initial = await page.evaluate(async (id) => {
    if (window.__docsPayloadStore) throw Error("A payload experiment is already attached");
    const candidates = new Set();
    for (const script of document.querySelectorAll("script[type=module][src]"))
      for (const value of Object.values(await import(script.src)))
        if (
          typeof value?.getState === "function" &&
          typeof value.getState().setTransportMode === "function"
        )
          candidates.add(value);
    if (candidates.size !== 1) throw Error("Expected one existing production Store");
    const store = [...candidates][0],
      state = store.getState();
    if (
      !state._all_data_initialized ||
      state._auth_phase !== "authenticated" ||
      Object.keys(state.configStore).length !== 1 ||
      !state.configStore[id] ||
      Object.values(state.statusStore).some((status) => status.running)
    )
      throw Error("Demo is not idle and ready");
    let previous = performance.now(),
      minimum = Infinity;
    for (let index = 0; index < 200000; index++) {
      const current = performance.now();
      if (current > previous) minimum = Math.min(minimum, current - previous);
      previous = current;
    }
    window.__docsPayloadStore = store;
    return {
      config: state.configStore[id],
      events: state.eventStore[id],
      mode: state.transportMode,
      webView: {
        userAgent: navigator.userAgent,
        visibility: document.visibilityState,
        crossOriginIsolated,
        timerObservedMinimumMs: minimum,
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      },
    };
  }, id);
  originalMode = initial.mode;
  assert.equal(canonical(initial.config), canonical(baseline));
  assert.deepEqual(initial.events, events);
  assert.equal(initial.webView.visibility, "visible");
  report.environment.webView = initial.webView;
  const orders = probe ? [[originalMode]] : transportOrders;
  for (const [round, order] of orders.entries())
    for (const mode of order) {
      const connection = await page.evaluate(switchPayloadTransport, { mode, id });
      for (const payloadBytes of payloadOrders[round]) {
        const payload = payloadText(payloadBytes),
          block = String(round).padStart(2, "0");
        const prepared = await page.evaluate(preparePayload, {
          id,
          payloadField,
          blockField,
          payload,
          block,
          baseline,
        });
        const expected = { ...baseline, [payloadField]: payload, [blockField]: block };
        assert.equal(canonical(JSON.parse(readFileSync(configPath))), canonical(expected));
        assert.deepEqual(readFileSync(eventPath), eventBytes);
        const result = await page.evaluate(measurePayloadBlock, {
          id,
          expected,
          warmup: report.method.warmupPerBlock,
          samples: report.method.samplesPerBlock,
          blockSize: report.method.blockSize,
        });
        report.blocks.push({
          round,
          mode,
          payloadBytes,
          ...connection,
          expectedConfigJsonBytes: prepared.decodedConfigJsonBytes,
          ...result,
        });
        save();
        assert.deepEqual(result.failures, [], "Failed block retained in private evidence");
        assert.equal(result.finalMode, mode);
        assert.equal(result.finalReady, true);
        assert.equal(result.samplesMs.length, report.method.samplesPerBlock);
        assert.equal(
          result.validated,
          report.method.samplesPerBlock + report.method.warmupPerBlock
        );
        console.log(
          JSON.stringify({
            round,
            mode,
            payloadBytes,
            samples: result.samplesMs.length,
            failures: result.failures.length,
          })
        );
      }
    }
  if (!probe) report.results = payloadResults(report.blocks);
  report.completed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  try {
    if (originalMode && page) {
      await page.evaluate(preparePayload, {
        id,
        payloadField,
        blockField,
        baseline,
        restore: true,
      });
      await page.evaluate(switchPayloadTransport, { mode: originalMode, id });
      assert.equal(canonical(JSON.parse(readFileSync(configPath))), canonical(baseline));
      assert.deepEqual(readFileSync(eventPath), eventBytes);
      writeFileSync(configPath, configBytes);
      assert.deepEqual(readFileSync(configPath), configBytes);
      const final = await page.evaluate((id) => {
        const state = window.__docsPayloadStore.getState();
        return {
          config: state.configStore[id],
          events: state.eventStore[id],
          mode: state.transportMode,
          ready: state._all_data_initialized && state._auth_phase === "authenticated",
          idle: !Object.values(state.statusStore).some((status) => status.running),
        };
      }, id);
      assert.equal(canonical(final.config), canonical(baseline));
      assert.deepEqual(final.events, events);
      assert.equal(final.mode, originalMode);
      assert.ok(final.ready && final.idle);
      report.restoration = {
        configBytes: true,
        eventBytes: true,
        storeConfig: true,
        storeEvents: true,
        originalMode: true,
        ready: true,
        idle: true,
      };
      report.restored = true;
    }
  } catch (error) {
    report.restorationFailure = { name: error.name, message: error.message };
    throw error;
  } finally {
    save();
    if (page)
      await page
        .evaluate(() => {
          delete window.__docsPayloadStore;
        })
        .catch(() => {});
    await browser.close();
    console.log(JSON.stringify({ output, completed: report.completed, restored: report.restored }));
  }
}
