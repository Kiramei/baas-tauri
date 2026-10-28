import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import report from "../evidence/android-game-validation.json";
import proof from "../evidence/android-x86-provenance.json";
import layout from "../evidence/android-diagnostics-layout.json";

const read = (file: string) => readFileSync(new URL("../../" + file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("Android game evidence retains failure, source and cleanup boundaries", () => {
  expect(report.sourceRevision).toBe(proof.sourceRevision);
  expect(report.apkSha256).toBe(proof.apkSha256.toLowerCase());
  expect(report.applicationId).toBe(proof.applicationId);
  expect(report.harnessSha256).toBe(hash(read("docs/scripts/probe-android-game.mjs")));
  expect(report.publisherSha256).toBe(hash(read("docs/scripts/summarize-android-game.mjs")));
  expect(report.outcome).toBe("failed-game-display-placement");
  expect(report.observations.backgroundDisplay.active).toBe(true);
  expect(report.observations.gameActivityDisplays).toEqual([0]);
  expect(report.observations.backgroundDisplay.displayId).toBeGreaterThan(0);
  expect(report.observations.placementDenialCount).toBeGreaterThan(0);
  expect(report.observations.trustedDisplay).toBe(false);
  expect(report.observations.displayFlags).not.toContain("FLAG_TRUSTED");
  expect(report.observations.nativeFrame.completelyBlack).toBe(true);
  expect(report.sources).toHaveLength(7);
  for (const source of report.sources) {
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(source.gitContentVerified).toBe(true);
  }
  for (const key of ["fieldsRestored", "profilesUnchanged", "eventsUnchanged", "displayInactive", "homePlayVisible", "gameStopped"])
    expect(report.restoration[key as keyof typeof report.restoration]).toBe(true);
  for (const key of ["gameInputSent", "gameTasksStarted", "gameLoginVerified", "gameTaskCompletionVerified", "nativeTakeoverRestartVerified", "nativeCloseButtonTapped"])
    expect(report[key as keyof typeof report]).toBe(false);
  expect(report.diagnosis.status).toContain("hypothesis");
  expect(JSON.stringify(report)).not.toMatch(/WorkSpace|\.codex_tmp|[A-Z]:\\|pngBase64|accountId|accessToken/);
});

test("Android troubleshooting removes obsolete controls and preserves localized failure diagnostics", () => {
  for (const locale of ["zh", "en"]) {
    const guide = read(`docs/content/docs/${locale}/guide/android.mdx`);
    const troubleshooting = read(`docs/content/docs/${locale}/reference/troubleshooting.mdx`);
    for (const text of [guide, troubleshooting]) {
      expect(text).toContain("Shizuku");
      expect(text).toContain("Not allow to launch ... on display");
    }
    expect(guide).toContain("FLAG_TRUSTED");
    expect(guide).toContain("3.0.2");
    expect(guide).toContain(report.diagnosis.reference);
    expect(troubleshooting).not.toMatch(/打开无障碍服务权限|通知栏脚本开关无效|Keep the foreground service notification alive|retry from the notification/);
    expect(troubleshooting).toContain(locale === "zh" ? "当前版本没有通知栏任务启动/停止按钮" : "This version has no notification task Start/Stop buttons");
  }
});

test("Android diagnostic links and headings pass both languages, themes and viewport sizes", () => {
  expect(layout.cases).toBe(8);
  expect(layout.failures).toBe(0);
  expect(layout.results).toHaveLength(8);
  for (const [file, expected] of Object.entries(layout.testedSources)) expect(hash(read(file))).toBe(expected);
  const combinations = new Set<string>();
  for (const result of layout.results) {
    expect(result.linkNavigated).toBe(true);
    expect(result.headingFits).toBe(true);
    expect(result.pageErrors).toEqual([]);
    expect(result.passed).toBe(true);
    combinations.add([result.locale, result.theme, result.mobile].join("/"));
  }
  expect(combinations.size).toBe(8);
});
