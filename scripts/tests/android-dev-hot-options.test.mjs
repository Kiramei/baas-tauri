import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../android-dev-hot.mjs", import.meta.url));
const runDry = (args, env = {}) =>
  spawnSync(process.execPath, [script, "--dry-run", ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      PATH: "",
      JAVA_HOME: "",
      ANDROID_HOME: "",
      BAAS_ANDROID_DEVICE: "",
      ...env,
    },
  });

test("dry run selects an explicit device and isolated package without Android tools", () => {
  const result = runDry([
    "--device",
    "phone-test",
    "--application-id",
    "io.github.kiramei.baas_tauri.dev",
    "--abi",
    "arm64",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /io\.github\.kiramei\.baas_tauri\.dev on device phone-test/);
  assert.match(result.stdout, /Dry run complete/);
});

test("default package and device environment option remain available", () => {
  const result = runDry([], { BAAS_ANDROID_DEVICE: "environment-phone" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /io\.github\.kiramei\.baas_tauri on device environment-phone/);
});

test("missing device never falls back to an emulator", () => {
  const result = runDry([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Specify --device <serial>/);
});

test("invalid application IDs fail before device or build actions", () => {
  const result = runDry(["--device", "phone-test", "--application-id", "invalid/package"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid Android application ID/);
});
