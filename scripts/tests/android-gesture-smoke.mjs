// Requires an active virtual display. Exercises real authenticated Android RPC.
// Usage: bun scripts/tests/android-gesture-smoke.mjs <serial> [package] [port]
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const [serial, packageName = "io.github.kiramei.baas_tauri", port = "17912"] = process.argv.slice(2);
assert(serial, "Specify the connected Android device serial");
execFileSync("adb", ["-s", serial, "forward", `tcp:${port}`, "tcp:7912"]);
const token = execFileSync("adb", ["-s", serial, "shell", "run-as", packageName,
  "cat", "files/android-local-device-token"], { encoding: "utf8" }).trim();
async function rpc(method, params) {
  const response = await fetch(`http://127.0.0.1:${port}/jsonrpc/0`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-BAAS-Token": token },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  assert(response.ok, `HTTP ${response.status} for ${method}`);
  const body = await response.json();
  assert(!body.error, JSON.stringify(body.error));
  return body.result;
}
try {
  const info = await rpc("deviceInfo", []);
  const width = info.displayWidth, height = info.displayHeight;
  let swipeCompleted = false;
  const started = performance.now();
  const swipe = rpc("swipe", [Math.round(width * .35), Math.round(height * .65),
    Math.round(width * .65), Math.round(height * .65), 240])
    .then(result => { assert.equal(result, true); swipeCompleted = true; });
  await new Promise(resolve => setTimeout(resolve, 200));
  const captureStarted = performance.now();
  const screenshot = await rpc("takeScreenshot", [1, 100]);
  const captureMs = performance.now() - captureStarted;
  const capturedDuringSwipe = !swipeCompleted;
  await swipe;
  const swipeMs = performance.now() - started;
  assert(screenshot && Buffer.from(screenshot, "base64").subarray(0, 8).equals(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "Screenshot must contain a PNG");
  assert(capturedDuringSwipe, "Screenshot waited for swipe completion");
  assert(swipeMs >= 1100, `Swipe duration was shortened: ${swipeMs}ms`);
  assert.equal(await rpc("pinchIn", [50, 60]), true);
  assert.equal(await rpc("pinchOut", [50, 60]), true);
  console.log(JSON.stringify({ capturedDuringSwipe, captureMs: Math.round(captureMs),
    swipeMs: Math.round(swipeMs), pinchIn: true, pinchOut: true }));
} finally {
  execFileSync("adb", ["-s", serial, "forward", "--remove", `tcp:${port}`]);
}
