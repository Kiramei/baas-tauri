import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import record from "../public/benchmarks/android-local-current.json";
import summary from "../public/benchmarks/android-local-summary.json";
import layout from "../evidence/android-local-layout.json";
import {
  androidLocalHarnessFiles,
  androidLocalResults,
  validateAndroidLocal,
} from "../scripts/android-local-data.mjs";

const read = (file: string) => readFileSync(new URL("../../" + file, import.meta.url));
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

test("Android local chart controls, labels and raw links have current bilingual browser evidence", () => {
  expect(layout.cases).toBe(64);
  expect(layout.failures).toBe(0);
  expect(
    layout.results.every(
      (row) =>
        row.passed &&
        row.valuesMatch &&
        row.sharedZeroAxis &&
        row.labelsFit &&
        row.tableMatches &&
        row.noOverflow
    )
  ).toBe(true);
  expect(
    new Set(
      layout.results.map((row) =>
        [row.locale, row.theme, row.mobile, row.kind, row.selection, row.metric].join(":")
      )
    ).size
  ).toBe(64);
  expect(layout.downloads).toHaveLength(8);
  expect(
    layout.downloads.every((row) => row.passed && row.nativeNavigation && row.rawBytesMatch)
  ).toBe(true);
  expect(layout.dataSha256).toBe(hash(read("docs/public/benchmarks/android-local-current.json")));
  expect(layout.summarySha256).toBe(
    hash(read("docs/public/benchmarks/android-local-summary.json"))
  );
  for (const [file, expected] of Object.entries(layout.testedSources))
    expect(hash(read(file).toString().replaceAll("\r\n", "\n"))).toBe(expected);
  for (const locale of ["zh", "en"]) {
    const page = read(`docs/content/docs/${locale}/reference/performance.mdx`).toString();
    expect(page).toContain(`<AndroidLocalBenchmark locale="${locale}" kind="capture" />`);
    expect(page).toContain(`<AndroidLocalBenchmark locale="${locale}" kind="control" />`);
  }
});

test("Android local measurements retain all formal samples, warm-ups and source identities", () => {
  const current = Object.fromEntries(
    androidLocalHarnessFiles.map((file) => [
      file,
      hash(read(file).toString().replaceAll("\r\n", "\n")),
    ])
  );
  expect(validateAndroidLocal(record, current)).toBe(record);
  expect(record.capture).toHaveLength(400);
  expect(record.control).toHaveLength(216);
  expect(record.warmups).toHaveLength(86);
  expect(record.publication.publisherSha256).toBe(
    hash(read("docs/scripts/publish-android-local.mjs"))
  );
  expect(record.publication.calculationSha256).toBe(
    hash(read("docs/scripts/android-local-data.mjs"))
  );
  for (const [file, expected] of Object.entries(record.targetSources))
    expect(hash(read(file).toString().replaceAll("\r\n", "\n"))).toBe(expected);
});

test("compact Android charts are recomputed from the complete record", () => {
  expect(record.results).toEqual(androidLocalResults(record));
  expect(summary.recordSha256).toBe(
    hash(read("docs/public/benchmarks/android-local-current.json"))
  );
  expect(summary.capture).toEqual(record.results.capture);
  expect(summary.control).toEqual(record.results.control);
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(10000);
  const component = read("docs/components/AndroidLocalBenchmark.tsx").toString();
  expect(component).toContain("android-local-summary.json");
  expect(component).not.toContain("android-local-current.json");
  expect(component).toContain('role="group"');
});

test("publication rejects probes, missing or reordered samples, wrong gestures and private diagnostics", () => {
  const mutations: ((value: any) => void)[] = [
    (value) => {
      value.probe = true;
    },
    (value) => {
      value.completed = false;
    },
    (value) => {
      value.verifiedEmbeddedProcess = false;
    },
    (value) => {
      value.capture.pop();
    },
    (value) => {
      value.control.pop();
    },
    (value) => {
      value.warmups.pop();
    },
    (value) => {
      value.capture[0].elapsedNs = -1;
    },
    (value) => {
      value.capture[0].method = "other";
    },
    (value) => {
      value.capture[0].mse = 2;
    },
    (value) => {
      value.capture[0].repeatedFrame = !value.capture[0].repeatedFrame;
    },
    (value) => {
      value.control[0].inputs++;
    },
    (value) => {
      value.control[0].visibleElapsedNs = 1;
    },
    (value) => {
      value.control.find((row: any) => row.scenario === "swipe").observedTravelPixels = 0;
    },
    (value) => {
      value.control[0].observedDurationMs = 1000;
    },
    (value) => {
      value.restoration.entrypointRestored = false;
    },
    (value) => {
      value.results.capture[0].p95Ms++;
    },
    (value) => {
      value.environment.path = "D:/WorkSpace/private";
    },
    (value) => {
      value.privateTraceback = "private diagnostic";
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(record);
    mutate(changed);
    expect(() => {
      validateAndroidLocal(changed);
    }).toThrow();
  }
  expect(() => validateAndroidLocal(record, {})).toThrow(/Measured harness changed/);
});
