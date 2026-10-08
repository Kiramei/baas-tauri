// Usage: bun scripts/tests/android-startup-smoke.mjs <serial> [package]
// Force-stops the selected app; do not run while it is executing automation.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const [serial, packageName = "io.github.kiramei.baas_tauri"] = process.argv.slice(2);
assert(serial, "Specify the connected device serial");
const adb = (...args) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 15000 });
adb("shell", "am", "force-stop", packageName);
const launchedAt = performance.now();
const launchTimestamp = Date.now();
adb("shell", "am", "start", "-n", `${packageName}/io.github.kiramei.baas_tauri.MainActivity`);
let pid;
while (performance.now() - launchedAt < 120000) {
  try { pid = adb("shell", "pidof", packageName).trim().split(" ")[0]; }
  catch { pid = undefined; }
  if (pid) {
    const logs = adb("logcat", "-d", "-t", "1500", `--pid=${pid}`);
    let match;
    let readyAt;
    try {
      const entries = adb("exec-out", "run-as", packageName, "cat", "logs/baas-tauri.jsonl").trim().split("\n").flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const entry = entries.findLast(entry => entry.timestampMs >= launchTimestamp && String(entry.message).includes("__ANDROID_HOME_READY__"));
      match = entry?.message.match(/__ANDROID_HOME_READY__ (\d+)ms/);
      readyAt = entry?.timestampMs;
    } catch { /* The logger is created after the native app process starts. */ }
    if (match) {
      const nativeStages = logs.split("\n").filter(line => line.includes("BAASStartup"));
      const activityTimestamp = Number(nativeStages.find(line => line.includes("activity_enter"))?.match(/wall=(\d+)/)?.[1]);
      const stageTime = stage => {
        const parts = nativeStages.find(line => line.includes(`BAASStartup: ${stage}`))?.match(/ (\d\d):(\d\d):(\d\d)\.(\d\d\d) /);
        assert(parts, `Missing native startup stage: ${stage}`);
        return ((Number(parts[1]) * 60 + Number(parts[2])) * 60 + Number(parts[3])) * 1000 + Number(parts[4]);
      };
      const contextMs = (stageTime("context_ready") - stageTime("context_start") + 86400000) % 86400000;
      assert(contextMs < 1000, `Tauri context initialization regressed: ${contextMs}ms`);
      console.log(JSON.stringify({ packageName, pid,
        // Activity and frontend timestamps share the phone's clock. Host ADB
        // request timing includes shell dispatch and must not stand in for tap latency.
        launchToHomeMs: activityTimestamp ? readyAt - activityTimestamp : null,
        adbRequestToHomeMs: readyAt - launchTimestamp,
        contextMs, webviewToHomeMs: Number(match[1]), nativeStages }));
      process.exit(0);
    }
    if (logs.includes("FATAL EXCEPTION")) throw new Error("App crashed during startup");
  }
  await new Promise(resolve => setTimeout(resolve, 500));
}
throw new Error("Home page did not commit within 120 seconds; inspect Android bootstrap status and logs");
