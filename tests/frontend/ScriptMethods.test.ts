import { expect, test } from "bun:test";
import { scriptMethodOptions } from "../../src/shared/ScriptMethods";

test("Docker offers device methods and preserves an imported host-only value as disabled", () => {
  const methods = [
    "adb",
    "nemu",
    "scrcpy",
    "uiautomator2",
    "mss",
    "pyautogui",
    "android_local",
    "adb",
    null,
  ];
  expect(scriptMethodOptions(methods, "mss", true)).toEqual([
    { value: "adb", disabled: false },
    { value: "scrcpy", disabled: false },
    { value: "uiautomator2", disabled: false },
    { value: "mss", disabled: true },
  ]);
  expect(scriptMethodOptions(methods, "adb", false).map(({ value }) => value)).toEqual([
    "adb",
    "nemu",
    "scrcpy",
    "uiautomator2",
    "mss",
    "pyautogui",
    "android_local",
  ]);
  expect(scriptMethodOptions(undefined, "custom", true)).toEqual([
    { value: "custom", disabled: false },
  ]);
});
