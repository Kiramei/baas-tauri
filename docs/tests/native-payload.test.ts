import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import published from "../public/benchmarks/native-payload-current.json";
import chart from "../public/benchmarks/native-payload-summary.json";
import layout from "../evidence/native-payload-layout.json";
import { summarize, transportOrders } from "../scripts/benchmark-statistics.mjs";
import {
  canonical,
  harnessFiles,
  payloadOrders,
  payloadResults,
  payloadSizes,
  payloadText,
  validatePayloadBenchmark,
} from "../scripts/native-payload-data.mjs";
import { measurePayloadBlock, preparePayload } from "../scripts/native-payload-browser.mjs";

test("payload controls and raw links retain source-bound checks for all presentation combinations", () => {
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  expect(layout.cases).toBe(48);
  expect(layout.failures).toBe(0);
  expect(
    layout.results.every(
      (result) =>
        result.passed &&
        result.sharedZeroAxis &&
        result.valuesMatch &&
        result.labelsFit &&
        result.tableMatches &&
        result.noOverflow
    )
  ).toBe(true);
  expect(
    new Set(
      layout.results.map((result) =>
        [result.locale, result.theme, result.mobile, result.payloadBytes, result.metric].join(":")
      )
    ).size
  ).toBe(48);
  expect(layout.downloads).toHaveLength(8);
  expect(
    layout.downloads.every(
      (result) => result.nativeNavigation && result.rawBytesMatch && result.passed
    )
  ).toBe(true);
  expect(layout.dataSha256).toBe(
    digest(
      readFileSync(new URL("../public/benchmarks/native-payload-current.json", import.meta.url))
    )
  );
  expect(layout.summarySha256).toBe(
    digest(
      readFileSync(new URL("../public/benchmarks/native-payload-summary.json", import.meta.url))
    )
  );
  for (const [file, hash] of Object.entries(layout.testedSources))
    expect(
      digest(
        readFileSync(new URL("../../" + file, import.meta.url))
          .toString()
          .replaceAll("\r\n", "\n")
      )
    ).toBe(hash);
});

test("published large-config data and compact chart agree with the measured sources", () => {
  const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const currentHashes = Object.fromEntries(
    harnessFiles.map((file) => [
      file,
      digest(readFileSync(new URL("../../" + file, import.meta.url))),
    ])
  );
  expect(validatePayloadBenchmark(published, currentHashes)).toBe(published);
  expect(chart.schemaVersion).toBe(1);
  expect(chart.recordSha256).toBe(
    digest(
      readFileSync(new URL("../public/benchmarks/native-payload-current.json", import.meta.url))
    )
  );
  expect(chart.results).toEqual(
    published.results.map((row) => ({
      ...row,
      decodedConfigJsonBytes: published.blocks.find(
        (block) => block.payloadBytes === row.payloadBytes
      )!.expectedConfigJsonBytes,
    }))
  );
  expect(Buffer.byteLength(JSON.stringify(chart))).toBeLessThan(10000);
  expect(published.publication.publisherSha256).toBe(
    digest(readFileSync(new URL("../scripts/publish-native-payload.mjs", import.meta.url)))
  );
  const verified = published.publication.backendSourceVerification;
  expect(verified.revision).toBe(published.backendRevision);
  expect(Object.keys(verified.files).sort()).toEqual(Object.keys(published.backendFiles).sort());
  for (const [file, check] of Object.entries(verified.files)) {
    expect(check.matchesRevision).toBe(true);
    expect(check.runtimeSha256).toBe(
      published.backendFiles[file as keyof typeof published.backendFiles]
    );
    expect(check.normalizedGitSha256).toMatch(/^[a-f0-9]{64}$/);
  }
  for (const size of payloadSizes)
    for (const mode of ["websocket", "pipe", "shm"]) {
      const result = published.results.find(
        (row) => row.mode === mode && row.payloadBytes === size
      )!;
      expect(result.count).toBe(600);
      expect(result.failedAttempts).toBe(0);
      expect(result.blockMeans.count).toBe(30);
    }
});

function fixture() {
  const blocks = transportOrders.flatMap((order, round) =>
    order.flatMap((mode) =>
      payloadOrders[round].map((payloadBytes) => ({
        round,
        mode,
        payloadBytes,
        finalMode: mode,
        finalReady: true,
        channels: ["provider", "sync", "trigger"],
        samplesMs: Array.from({ length: 100 }, (_, index) => index / 10),
        warmupMs: Array(20).fill(1),
        blockMeansMs: Array(5).fill(5),
        validated: 120,
        failures: [],
        unexpectedUpdates: 0,
        decodedConfigJsonBytes: [payloadBytes + 100],
        expectedConfigJsonBytes: payloadBytes + 100,
        readinessMs: 1,
      }))
    )
  );
  return {
    schemaVersion: 1,
    probe: false,
    completed: true,
    restored: true,
    restoration: {
      configBytes: true,
      eventBytes: true,
      storeConfig: true,
      storeEvents: true,
      originalMode: true,
      ready: true,
      idle: true,
    },
    sourceRevision: "a".repeat(40),
    backendRevision: "b".repeat(40),
    executableSha256: "c".repeat(64),
    baselineConfigSha256: "d".repeat(64),
    baselineEventsSha256: "e".repeat(64),
    backendFiles: Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [String(i), "f".repeat(64)])
    ),
    harnessFiles: Object.fromEntries(harnessFiles.map((file) => [file, "a".repeat(64)])),
    payloads: payloadSizes.map((bytes) => ({
      bytes,
      sha256: createHash("sha256").update(payloadText(bytes)).digest("hex"),
    })),
    method: {
      orders: transportOrders,
      payloadOrders,
      samplesPerBlock: 100,
      warmupPerBlock: 20,
      blockSize: 20,
      concurrency: 1,
    },
    environment: { webView: { timerObservedMinimumMs: 0.1 } },
    blocks,
    results: payloadResults(blocks),
  };
}

test("synthetic payload sizes and both experiment orders stay balanced", () => {
  for (const size of payloadSizes) {
    expect(Buffer.byteLength(payloadText(size))).toBe(size);
    expect(payloadText(size)).toMatch(/^[\w-]+$/);
    for (let position = 0; position < 3; position++)
      expect(payloadOrders.filter((order) => order[position] === size)).toHaveLength(2);
  }
  expect(() => payloadText(10)).toThrow();
  expect(canonical({ b: { d: 1, c: 2 }, a: [2, 1] })).toBe('{"a":[2,1],"b":{"c":2,"d":1}}');
});

test("cleanup refreshes release Store state before and after deleting synthetic fields", async () => {
  const previousWindow = globalThis.window;
  try {
    for (const backendAlreadyClean of [false, true]) {
      const baseline = { autostart: false, name: "Demo" };
      const dirty = { ...baseline, field: "payload", block: "00" };
      let backend: any = backendAlreadyClean ? { ...baseline } : { ...dirty };
      let pulls = 0,
        patches = 0;
      const state: any = {
        configStore: { demo: dirty },
        statusStore: {},
        pendingCallbacks: {},
        send: (_: string, message: any) => {
          if (message.type === "pull") {
            pulls++;
            queueMicrotask(() => {
              state.configStore = { demo: structuredClone(backend) };
            });
          } else {
            patches++;
            for (const op of message.ops) delete backend[op.path.slice(1)];
            queueMicrotask(() => {
              state.pendingCallbacks[message.timestamp]();
              delete state.pendingCallbacks[message.timestamp];
            });
          }
        },
      };
      (globalThis as any).window = { __docsPayloadStore: { getState: () => state } };
      await preparePayload({
        id: "demo",
        payloadField: "field",
        blockField: "block",
        baseline,
        restore: true,
      });
      expect(state.configStore.demo).toEqual(baseline);
      expect(backend).toEqual(baseline);
      expect(pulls).toBe(backendAlreadyClean ? 1 : 2);
      expect(patches).toBe(backendAlreadyClean ? 0 : 1);
    }
  } finally {
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;
  }
});

test("publication recomputes all 5400 calls and refuses weak or altered evidence", () => {
  const original = fixture();
  expect(validatePayloadBenchmark(original, original.harnessFiles)).toBe(original);
  expect(original.results.reduce((total, row) => total + row.count, 0)).toBe(5400);
  const mutations = [
    (r: any) => {
      r.probe = true;
    },
    (r: any) => {
      r.completed = false;
    },
    (r: any) => {
      r.restored = false;
    },
    (r: any) => {
      r.restoration = {};
    },
    (r: any) => {
      r.blocks[0].samplesMs.pop();
    },
    (r: any) => {
      r.blocks[0].warmupMs.pop();
    },
    (r: any) => {
      r.blocks[0].validated--;
    },
    (r: any) => {
      r.blocks[0].unexpectedUpdates++;
    },
    (r: any) => {
      r.blocks[0].failures.push({ reason: "timeout" });
    },
    (r: any) => {
      r.blocks[0].decodedConfigJsonBytes[0]++;
    },
    (r: any) => {
      r.results[0].p95Ms++;
    },
    (r: any) => {
      r.payloads[0].sha256 = "0".repeat(64);
    },
    (r: any) => {
      r.backendRevision = "unknown";
    },
    (r: any) => {
      r.environment.path = "D:/WorkSpace/private";
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original);
    mutate(changed);
    expect(() => validatePayloadBenchmark(changed)).toThrow();
  }
  expect(() => validatePayloadBenchmark(original, {})).toThrow(/Harness changed/);
});

test("browser observer validates every reply after the Store notification and records mismatches", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  try {
    for (const mismatch of [false, true]) {
      const expected = { demo: true, field: "test" };
      const listeners = new Set<(state: any) => void>();
      let state: any;
      state = {
        configStore: { demo: expected },
        statusStore: {},
        _all_data_initialized: true,
        transportMode: "shm",
        send: (channel: string, message: any) => {
          expect(channel).toBe("sync");
          expect(message).toEqual({ type: "pull", resource: "config", resource_id: "demo" });
          queueMicrotask(() => {
            state = {
              ...state,
              configStore: { demo: mismatch ? { ...expected, field: "wrong" } : { ...expected } },
            };
            for (const listener of listeners) listener(state);
          });
        },
      };
      const store = {
        getState: () => state,
        subscribe: (listener: (state: any) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      (globalThis as any).window = { __docsPayloadStore: store };
      (globalThis as any).document = { visibilityState: "visible" };
      const result = await measurePayloadBlock({
        id: "demo",
        expected,
        warmup: 2,
        samples: 4,
        blockSize: 2,
      });
      expect(listeners.size).toBe(0);
      if (mismatch) {
        expect(result.failures[0].reason).toBe("Snapshot content mismatch");
        expect(result.samplesMs).toHaveLength(0);
      } else {
        expect(result.failures).toEqual([]);
        expect(result.validated).toBe(6);
        expect(result.samplesMs).toHaveLength(4);
        expect(result.warmupMs).toHaveLength(2);
        expect(result.blockMeansMs).toHaveLength(2);
        expect(summarize(result.samplesMs).minimumMs).toBeGreaterThanOrEqual(0);
      }
    }
  } finally {
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;
    if (previousDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previousDocument;
  }
});
