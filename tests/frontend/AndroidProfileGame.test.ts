import { describe, expect, test } from "bun:test";
import {
  AndroidProfileGameSession,
  androidPackageForServer,
  isAndroidProfileDisplayReady,
  otherRunningAndroidProfiles,
  resolveAndroidProfileGame,
  type AndroidInstalledGame,
} from "../../src/shared/AndroidProfileGame";
import { SERVER_VALUES } from "../../src/shared/serverOptions";

const official: AndroidInstalledGame = {
  packageName: "com.RoamingStar.BlueArchive",
  label: "CN",
  iconPngBase64: "",
};
const bilibili: AndroidInstalledGame = {
  packageName: "com.RoamingStar.BlueArchive.bilibili",
  label: "Bilibili",
  iconPngBase64: "",
};

describe("Android game selection belongs to the profile server", () => {
  test("a CN profile cannot fall back to the only installed Bilibili client", () => {
    expect(resolveAndroidProfileGame(SERVER_VALUES.CN_OFFICIAL, [bilibili])).toEqual({
      state: "missing",
      packageName: official.packageName,
    });
    expect(resolveAndroidProfileGame(SERVER_VALUES.CN_BILIBILI, [bilibili])).toEqual({
      state: "ready",
      packageName: bilibili.packageName,
      game: bilibili,
    });
  });

  test("installation order never overrides the configured server", () => {
    for (const games of [
      [official, bilibili],
      [bilibili, official],
    ]) {
      expect(resolveAndroidProfileGame(SERVER_VALUES.CN_OFFICIAL, games)).toMatchObject({
        game: official,
      });
      expect(resolveAndroidProfileGame(SERVER_VALUES.CN_BILIBILI, games)).toMatchObject({
        game: bilibili,
      });
    }
  });

  test("unsupported and unloaded servers cannot launch an arbitrary client", () => {
    for (const server of [undefined, null, "auto", "Steam国际服"]) {
      expect(resolveAndroidProfileGame(server, [official, bilibili])).toEqual({
        state: "unsupported",
      });
    }
    expect(androidPackageForServer(SERVER_VALUES.GLOBAL)).toBe("com.nexon.bluearchive");
    expect(androidPackageForServer(SERVER_VALUES.GLOBAL_TEEN)).toBe("com.nexon.bluearchiveteen");
    expect(androidPackageForServer(SERVER_VALUES.KR_ONE)).toBe("com.nexon.bluearchiveone");
    expect(androidPackageForServer(SERVER_VALUES.JP)).toBe("com.YostarJP.BlueArchive");
  });

  test("a different running profile blocks the shared display while the current profile may stop", () => {
    const statuses = { a: { running: true }, b: { running: false }, gone: undefined };
    expect(otherRunningAndroidProfiles(statuses, "a")).toEqual([]);
    expect(otherRunningAndroidProfiles(statuses, "b")).toEqual(["a"]);
    expect(otherRunningAndroidProfiles({ ...statuses, a: { running: false } }, "b")).toEqual([]);
    expect(otherRunningAndroidProfiles({ ...statuses, b: { running: true } }, "a")).toEqual(["b"]);
  });

  test("a display is reusable only for the same profile, client, and live display id", () => {
    const session = new AndroidProfileGameSession();
    const status = { active: true, displayId: 5 };
    expect(
      isAndroidProfileDisplayReady(session.getSnapshot(), "b1", bilibili.packageName, status)
    ).toBe(false);
    let notifications = 0;
    const unsubscribe = session.subscribe(() => {
      notifications += 1;
    });
    session.claim({ profileId: "b1", packageName: bilibili.packageName, displayId: 5 });
    const binding = session.getSnapshot();
    expect(isAndroidProfileDisplayReady(binding, "b1", bilibili.packageName, status)).toBe(true);
    expect(isAndroidProfileDisplayReady(binding, "b2", bilibili.packageName, status)).toBe(false);
    expect(isAndroidProfileDisplayReady(binding, "b1", official.packageName, status)).toBe(false);
    expect(
      isAndroidProfileDisplayReady(binding, "b1", bilibili.packageName, {
        active: false,
        displayId: 5,
      })
    ).toBe(false);
    expect(
      isAndroidProfileDisplayReady(binding, "b1", bilibili.packageName, {
        active: true,
        displayId: 6,
      })
    ).toBe(false);
    session.claim({ profileId: "b2", packageName: bilibili.packageName, displayId: 5 });
    expect(
      isAndroidProfileDisplayReady(session.getSnapshot(), "b1", bilibili.packageName, status)
    ).toBe(false);
    session.clear();
    expect(session.getSnapshot()).toBeNull();
    expect(notifications).toBe(3);
    unsubscribe();
    session.clear();
    expect(notifications).toBe(3);
  });
});
