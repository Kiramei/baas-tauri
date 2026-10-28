import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import report from "../evidence/search-cache-validation.json";

const read = (file: string) => readFileSync(new URL("../../" + file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("cached generations and reload recovery have source-bound browser evidence", () => {
  expect(report.cases).toBe(24);
  expect(report.failures).toBe(0);
  expect(report.searchIndexPath).toBe(`search-index/${report.searchIndexRevision}.json`);
  expect(report.searchIndexRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(report.searchIndexSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.scope).toContain("no game or emulator operated");
  for (const [file, expected] of Object.entries(report.testedSources)) expect(hash(read(file))).toBe(expected);
  const combinations = new Set<string>(), recoveries = new Set<string>();
  for (const result of report.results) {
    expect(result.currentResultsFound).toBe(true);
    expect(result.oldMarkerAbsent).toBe(true);
    expect(result.pageErrors).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.requests).toEqual(result.failure === "cached-old"
      ? { current: 1, old: 1, legacy: 1 }
      : { current: 2, old: 0, legacy: 0 });
    combinations.add([result.locale, result.theme, result.mobile, result.failure].join("/"));
    recoveries.add(result.recovery);
  }
  expect(combinations.size).toBe(24);
  expect(recoveries).toEqual(new Set(["none", "button-reload", "enter-reload"]));
  expect(JSON.stringify(report)).not.toMatch(/WorkSpace|\.codex_tmp|[A-Z]:\\|accessToken|accountId/);
});
