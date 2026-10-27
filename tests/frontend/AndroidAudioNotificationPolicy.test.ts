import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const androidSource = (name: string) => readFileSync(new URL(
  `../../src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/${name}.kt`, import.meta.url
), "utf8");

test("native preview and game launch no longer mute game audio", () => {
  const controller = androidSource("ShizukuController");
  expect(controller).not.toContain("GameAudioMute");
  expect(controller).toContain("LegacyGameAudioSettings.restoreAll(context)");
  const recovery = androidSource("LegacyGameAudioSettings");
  expect(recovery).not.toContain("PLAY_AUDIO ignore");
  expect(recovery).not.toContain("fun mute(");
  expect(recovery).toContain("saved.edit().remove(packageName)");
});

test("startup does not request notification permission again", () => {
  expect(androidSource("MainActivity")).not.toContain("POST_NOTIFICATIONS");
  expect(androidSource("ShizukuController")).toContain("disableOwnNotifications(context.applicationInfo.uid)");
  expect(androidSource("ShizukuShellService")).toContain(".invoke(notifications, BuildConfig.APPLICATION_ID, appUid, false)");
});
