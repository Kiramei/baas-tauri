import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [run, sourceRepo] = process.argv.slice(2);
assert.match(run || "", /^[a-z0-9-]+$/);
assert.ok(sourceRepo, "Pass the independently checked Android source repository");
const cache = path.join(root, ".cache/android-game-session", run);
const read = (file) => readFileSync(path.join(cache, file));
const json = (file) => JSON.parse(read(file));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const lf = (value) => value.toString("utf8").replaceAll("\r\n", "\n");
const proof = JSON.parse(readFileSync(path.join(root, "docs/evidence/android-x86-provenance.json")));
const started = json("cold-start.json");
const restored = json("restored.json");
const finished = json("final-restored.json");
const harnessSha256 = sha(lf(readFileSync(path.join(root, "docs/scripts/probe-android-game.mjs"))));
for (const record of [started, restored, finished]) assert.equal(record.harnessSha256, harnessSha256);
for (const record of [started, finished]) {
  assert.equal(record.apkSha256, proof.apkSha256.toLowerCase());
  assert.equal(record.package, proof.applicationId);
  assert.equal(record.sourceRevision, proof.sourceRevision);
  assert.equal(record.game, "com.RoamingStar.BlueArchive.bilibili");
}
assert.equal(started.mode, "start");
assert.equal(started.display.active, true);
assert.equal(started.display.mode, "shizuku");
assert.ok(Number.isInteger(started.display.displayId) && started.display.displayId > 0);
assert.equal(finished.mode, "close");
assert.equal(finished.display.active, false);
for (const key of ["fieldsRestored", "profilesUnchanged", "eventsUnchanged", "displayInactive", "homePlayVisible", "gameStopped"])
  assert.equal(restored[key], true);

const component = started.game + "/com.tech.sdk.bridge.TechSDKUnityPlayerActivity";
const activities = read("cold-start-activities.txt").toString("utf8");
let currentDisplay = null;
const activityDisplays = new Set();
for (const line of activities.split(/\r?\n/)) {
  const heading = /^Display #(\d+) \(activities from top to bottom\):/.exec(line);
  if (heading) currentDisplay = Number(heading[1]);
  if (line.trim() === "mActivityComponent=" + component) activityDisplays.add(currentDisplay);
}
assert.deepEqual([...activityDisplays], [0], "The game placement no longer reproduces this failure");
const denialLines = read("cold-start-logcat.txt").toString("utf8").split(/\r?\n/)
  .filter((line) => line.includes("Not allow to launch ") && line.includes(component) && line.endsWith(" on display " + started.display.displayId));
assert.ok(denialLines.length > 0, "No corresponding Android placement denial was captured");
const deviceLine = read("cold-start-displays.txt").toString("utf8").split(/\r?\n/)
  .find((line) => line.trim().startsWith('DisplayDeviceInfo{"BAAS Game":'));
assert.ok(deviceLine);
const displayFlags = [...new Set(deviceLine.match(/\bFLAG_[A-Z_]+\b/g) || [])];
assert.equal(displayFlags.includes("FLAG_TRUSTED"), false);
const shellPackage = read("cold-start-shell-package.txt").toString("utf8");
const gameVersion = /\bversionName=([^\s]+)/.exec(read("cold-start-game-package.txt").toString("utf8"))?.[1];
assert.ok(gameVersion);
const frame = read("cold-start-game.png");
const shot = started.screenshots.find((item) => item.kind === "native-game");
assert.equal(sha(frame), shot.sha256);
const stats = await sharp(frame).stats();
const frameMetadata = await sharp(frame).metadata();
assert.equal(frameMetadata.width, shot.width);
assert.equal(frameMetadata.height, shot.height);

const prefix = "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/";
const sources = ["src/pages/HomePage.tsx", "src/android/components/AndroidGamePanel.tsx", "src-tauri/src/mobile_commands.rs",
  ...["ShizukuShellService.kt", "PrivilegedDisplayMain.kt", "GameTaskTransfer.kt", "BackendServicePlugin.kt"].map((file) => prefix + file)]
  .map((file) => {
    const blob = execFileSync("git", ["-C", sourceRepo, "show", proof.sourceRevision + ":" + file], { windowsHide: true, timeout: 15000 });
    assert.equal(lf(readFileSync(path.join(sourceRepo, file))), lf(blob), "Source drift: " + file);
    return { file, sha256: sha(lf(blob)), gitContentVerified: true };
  });
const postRunProperty = (name) => execFileSync("adb", ["-s", "127.0.0.1:16384", "shell", "getprop", name],
  { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim();
const android = postRunProperty("ro.build.version.release");
const sdk = Number(postRunProperty("ro.build.version.sdk"));
assert.equal(android, "15");
assert.equal(sdk, 35);
assert.match(deviceLine, /owner com\.android\.shell \(uid 2000\)/);
const report = {
  checkedAt: finished.checkedAt,
  sourceRevision: proof.sourceRevision,
  apkSha256: proof.apkSha256.toLowerCase(),
  applicationId: proof.applicationId,
  harnessSha256,
  publisherSha256: sha(lf(readFileSync(fileURLToPath(import.meta.url)))),
  environment: { device: "MuMu", android, sdk, appAbi: proof.abi, shizukuUid: 2000, game: started.game, gameVersion,
    versionPropertiesCheckedAt: new Date().toISOString(), versionPropertyScope: "Post-run ADB getprop check; game version and shell display-owner UID come from the captured run" },
  operation: "Actual Home background-game play button; all 26 documentation tasks disabled, every scheduler idle and profile autostart off",
  outcome: "failed-game-display-placement",
  observations: {
    observedAt: started.checkedAt,
    backgroundDisplay: started.display,
    gameActivity: component,
    gameActivityDisplays: [...activityDisplays],
    placementDenialCount: denialLines.length,
    placementDenial: "Android refused the game Unity Activity on the intended background display",
    displayFlags,
    trustedDisplay: false,
    shellPackageListsAddTrustedDisplayPermission: shellPackage.includes("android.permission.ADD_TRUSTED_DISPLAY"),
    nativeFrame: { sha256: shot.sha256, width: shot.width, height: shot.height, completelyBlack: stats.channels.slice(0, 3).every((channel) => channel.max === 0) },
  },
  sources,
  diagnosis: {
    status: "source-supported hypothesis; no repaired APK tested",
    explanation: "The shell display path omits the trusted flag; Android restricts ordinary-app launches onto untrusted displays. The privileged initial launch does not validate later game Activity transitions.",
    reference: "https://android.googlesource.com/platform/frameworks/base/+/android-15.0.0_r1/services/core/java/com/android/server/wm/ActivityTaskSupervisor.java",
  },
  restoration: restored,
  gameInputSent: false,
  gameTasksStarted: false,
  gameLoginVerified: false,
  gameTaskCompletionVerified: false,
  nativeTakeoverRestartVerified: false,
  nativeCloseButtonTapped: false,
  scope: "One hash-bound cold launch; a prior exploratory launch reproduced the placement failure. Cleanup exercised the overlay event handler through the probe, not a physical native-button tap. No game data was cleared, no login performed and no Shizuku mode or permissions changed. Raw screenshots, profile backup and system dumps remain in ignored cache, not public media. This is not a timing benchmark or proof of failure on every Android device.",
};
writeFileSync(path.join(root, "docs/evidence/android-game-validation.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outcome: report.outcome, sources: sources.length, restored: restored.displayInactive && restored.profilesUnchanged, publicMediaAdded: 0 }));
