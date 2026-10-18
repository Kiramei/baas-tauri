// Run with: bun scripts/benchmark-log-batching.ts [rows] [rounds]
// Measures JS state preparation, not WebView rendering or end-to-end transport latency.
import assert from "node:assert/strict";
import { appendLogGroups, groupLogEntries } from "../src/store/LogBatch";
import type { LogItem, RawLogItem } from "../src/types/app";

const count = Number(process.argv[2] ?? 10_000);
const rounds = Number(process.argv[3] ?? 7);
if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(rounds) || rounds <= 0) {
  throw new Error("rows and rounds must be positive integers");
}
const entries: RawLogItem[] = Array.from({ length: count }, (_, index) => ({
  scope: index % 4 === 0 ? "config:1" : "global",
  time: "2026-10-15T12:00:00+00:00",
  level: "INFO",
  message: `Recognition result ${index}`,
}));

function run(batched: boolean) {
  let logs: Record<string, LogItem[]> = {};
  let globalLogs: LogItem[] = [];
  let notifications = 0;
  const started = performance.now();
  if (batched) {
    for (let offset = 0; offset < entries.length; offset += 256) {
      const groups = groupLogEntries(entries.slice(offset, offset + 256));
      logs = appendLogGroups(logs, groups);
      notifications += 1;
      if (groups.global) {
        globalLogs = [...globalLogs, ...groups.global];
        notifications += 1;
      }
    }
  } else {
    for (const { scope, time, level, message } of entries) {
      const info = { time, level, message };
      logs = { ...logs, [scope]: [...(logs[scope] ?? []), info] };
      notifications += 1;
      if (scope === "global") {
        globalLogs = [...globalLogs, info];
        notifications += 1;
      }
    }
  }
  return { elapsedMs: performance.now() - started, notifications, logs, globalLogs };
}

const expected = run(false);
const optimized = run(true);
assert.deepEqual(optimized.logs, expected.logs);
assert.deepEqual(optimized.globalLogs, expected.globalLogs);
const samples = { before: [] as number[], after: [] as number[] };
for (let round = 0; round < rounds; round += 1) {
  // Alternate order to reduce warm-up bias.
  for (const batched of round % 2 === 0 ? [false, true] : [true, false]) {
    samples[batched ? "after" : "before"].push(run(batched).elapsedMs);
  }
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({
  scope: "JavaScript store preparation only; all rows preserved; batch size 256",
  rows: count,
  rounds,
  before: { medianMs: median(samples.before), notifications: expected.notifications, samplesMs: samples.before },
  after: { medianMs: median(samples.after), notifications: optimized.notifications, samplesMs: samples.after },
}, null, 2));
