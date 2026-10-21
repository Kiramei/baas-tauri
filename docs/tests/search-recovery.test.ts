import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import report from "../evidence/search-recovery.json";

const read = (file: string) => readFileSync(new URL("../../" + file, import.meta.url));
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

test("search recovery is verified against the current client and exported index", () => {
  expect(report.cases).toBe(24);
  expect(report.failures).toBe(0);
  expect(report.results).toHaveLength(24);
  for (const [file, expected] of Object.entries(report.testedSources)) {
    expect(sha(read(file).toString().replaceAll("\r\n", "\n"))).toBe(expected);
  }
  expect(report.searchIndexPath).toMatch(/^search-index\/[a-f0-9]{64}\.json$/);
  expect(report.searchIndexSha256).toBe(sha(read("docs/out/" + report.searchIndexPath)));
  const combinations = new Set<string>();
  const retryMethods = new Set<string>();
  for (const result of report.results) {
    expect(result.requests).toBe(2);
    expect(result.navigated).toBe(true);
    expect(result.passed).toBe(true);
    combinations.add([result.locale, result.theme, result.mobile, result.failure].join("/"));
    retryMethods.add(result.retryMethod);
  }
  expect(combinations.size).toBe(24);
  expect(retryMethods).toEqual(new Set(["button-after-reopen", "keyboard", "query-change"]));
  expect(JSON.stringify(report)).not.toMatch(
    /WorkSpace|\.codex_tmp|[A-Z]:\\|accessToken|accountId/
  );
});
