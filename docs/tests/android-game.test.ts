import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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

test("physical-device supplement separates APK failures, measured progress and manual side effects", () => {
  const current = report.currentReviewSupplement;
  expect(current.apkKind).toBe("debug-review");
  expect(current.applicationId).toBe("io.github.kiramei.baas_tauri.review");
  expect(current.environment.sdk).toBe(31);
  expect(current.runs).toHaveLength(4);
  expect(new Set(current.runs.map(run => run.apkSha256)).size).toBe(4);
  expect(new Set(current.runs.map(run => run.sourceRevision)).size).toBe(4);
  for (const run of current.runs) {
    expect(run.apkSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
  }
  expect(current.runs[1].sustainedQueueFrameProgress).toBe("failed");
  expect(current.runs[2].embeddedFocusRecovery).toBe("failed");
  expect(current.runs[2].ocrRepeated).toBe(false);
  expect(current.runs[2].restartTaskRepeated).toBe(false);
  const observations = current.runs[3].observations!;
  expect(observations.embeddedFocus.safetyGuardBypassed).toBe(false);
  expect(observations.embeddedFocus.actualDispatcherAfterShieldRemoval).toBe(observations.embeddedFocus.ownedDisplayId);
  for (const progress of [observations.embeddedFocus.postRemovalProgress, observations.queueProgress, observations.logSelection.liveProgress]) {
    expect(progress.allLiveWithOwnedFocusAndNoShield).toBe(true);
    expect(progress.samples).toBeGreaterThan(1);
    for (const counter of ["capturedFrames", "presentedFrames", "displayedFrames"] as const)
      expect(progress.lastCounters[counter]).toBeGreaterThan(progress.firstCounters[counter]);
  }
  expect(observations.queueProgress.elapsedSeconds).toBeGreaterThan(8);
  expect(observations.ocr.recognizedExpectedStaticChineseLabels).toEqual(["通知", "点击任意区域进入游戏", "菜单"]);
  expect(observations.runner.task).toBe("restart");
  expect(observations.runner.schedulerOrResourceTasksStarted).toBe(false);
  expect(observations.logSelection.imeShown).toBe(false);
  expect(observations.logSelection.clipboardReadbackVerified).toBe(false);
  expect(observations.unintendedInteraction.manualGameTapCount).toBe(1);
  expect(observations.unintendedInteraction.gameHomeAnnouncementEntered).toBe(true);
  expect(observations.unintendedInteraction.automatedGameplayCompletion).toBe(false);
  expect(observations.cleanup.ownedDisplayReleased).toBe(true);
  expect(observations.cleanup.temporaryFocusSurfaceCount).toBe(0);
  expect(observations.cleanup.remainingTestHostForwards).toBe(0);
  expect(current.sources).toHaveLength(4);
  for (const source of current.sources) {
    expect(source.revision).toBe(current.runs[3].sourceRevision);
    expect(source.gitContentVerified).toBe(true);
    // Each physical observation belongs to its tested APK, not later source edits.
    const pinned = execFileSync("git", ["show", `${source.revision}:${source.file}`], {
      cwd: new URL("../../", import.meta.url), encoding: "utf8",
    }).replaceAll("\r\n", "\n");
    expect(hash(pinned)).toBe(source.sha256);
  }
  expect(current.limitations.join(" ")).toContain("No complete pre-install configuration-byte baseline");
  expect(current.limitations.join(" ")).toContain("preservation is not claimed");
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
