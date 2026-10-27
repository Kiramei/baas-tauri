import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the shared home log heading has no count on any platform", () => {
  const source = readFileSync(new URL("../../src/pages/HomePage.tsx", import.meta.url), "utf8");
  const heading = source
    .match(/<h2\b[^>]*>[\s\S]*?<\/h2>/g)
    ?.find((text) => text.includes('t("log")'));
  expect(heading).toBeDefined();
  expect(heading).not.toContain("activeLogs");
  expect(source).toContain("<Logger logs={logs}");
  expect(source).toContain("<ProfileLogView");
  expect(source).toContain("onClick={exportLog}");
});
