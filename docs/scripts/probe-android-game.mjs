import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [mode = "snapshot", label = mode] = process.argv.slice(2);
assert.ok(["start", "snapshot", "close"].includes(mode));
assert.match(label, /^[a-z0-9-]+$/);
const serial = "127.0.0.1:16384";
const game = "com.RoamingStar.BlueArchive.bilibili";
const proof = JSON.parse(readFileSync(path.join(root, "docs/evidence/android-x86-provenance.json")));
const pkg = proof.applicationId;
const run = process.env.ANDROID_GAME_PROBE_RUN || "";
assert.ok(run === "" || /^[a-z0-9-]+$/.test(run));
const cache = path.join(root, ".cache/android-game-session", run);
mkdirSync(cache, { recursive: true });
const backupFile = path.join(cache, "baseline.json");
const adb = (args, options = {}) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", windowsHide: true, timeout: 15000, ...options });
const sha = (value) => createHash("sha256").update(value).digest("hex");
const harnessSha256 = sha(readFileSync(fileURLToPath(import.meta.url), "utf8").replaceAll("\r\n", "\n"));
const apk = adb(["shell", "pm", "path", pkg]).trim().replace(/^package:/, "");
assert.match(apk, /^\/data\/app\/[a-zA-Z0-9_./~+=-]+\/base\.apk$/);
assert.equal(adb(["shell", "sha256sum", apk]).trim().split(/\s+/)[0], proof.apkSha256.toLowerCase());
const forward = execFileSync("adb", ["forward", "--list"], { encoding: "utf8", windowsHide: true, timeout: 15000 }).split(/\r?\n/)
  .find((line) => line.startsWith(serial + " ") && line.includes(" tcp:19233 "));
assert.ok(forward);
const webviewPid = /localabstract:webview_devtools_remote_(\d+)/.exec(forward)?.[1];
assert.ok(webviewPid);
assert.equal(adb(["shell", "cat", `/proc/${webviewPid}/cmdline`]).replaceAll("\0", "").trim(), pkg);

const browser = await chromium.connectOverCDP("http://127.0.0.1:19233", { noDefaults: true, timeout: 10000 });
try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url() === "http://tauri.localhost/");
  assert.ok(page);
  page.setDefaultTimeout(20000);
  const attach = () => page.evaluate(async () => {
    const urls = performance.getEntriesByType("resource").map((entry) => entry.name)
      .filter((url) => url.startsWith(location.origin + "/assets/WebsocketStore-") && url.endsWith(".js"));
    const stores = new Set();
    for (const url of new Set(urls)) for (const value of Object.values(await import(url))) {
      if (typeof value?.getState === "function" && value.getState()._all_data_initialized && value.getState()._auth_phase === "authenticated") stores.add(value);
    }
    if (stores.size !== 1) throw new Error("Expected one ready production store");
    const store = [...stores][0];
    const state = store.getState();
    if (Object.values(state.statusStore).some((status) => status.running)) throw new Error("Tasks are running");
    if (Object.values(state.configStore).some((config) => config.autostart)) throw new Error("Autostart is enabled");
    const profiles = Object.entries(state.configStore).filter(([, config]) => config.name === "Documentation Demo");
    if (profiles.length !== 1 || profiles[0][1].server !== "B服") throw new Error("Expected the Bilibili demo profile");
    const [id, config] = profiles[0];
    if (state.eventStore[id].length !== 26 || state.eventStore[id].some((event) => event.enabled)) throw new Error("Demo tasks are not disabled");
    window.__docsGameProbeStore = store;
    return { id, configs: state.configStore, events: state.eventStore,
      fields: Object.fromEntries(["adbIP", "adbPort", "control_method", "screenshot_method"].map((key) => [key, config[key]])) };
  });
  const initial = await attach();
  const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const display = () => invoke("android_scrcpy_virtual_display_status", { serial: "auto" });
  const zh = await page.getByRole("button", { name: "主页", exact: true }).filter({ visible: true }).count() > 0;
  await page.locator(`[id='tab-${initial.id}']`).filter({ visible: true }).click();
  assert.equal(await page.locator(`[id='tab-${initial.id}']`).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: zh ? "主页" : "Home", exact: true }).filter({ visible: true }).click();
  if (mode === "start") {
    assert.equal(existsSync(backupFile), false, "A prior game probe baseline exists; close/restore it before starting a new session");
    assert.equal((await display()).active, false);
    try {
      const pids = adb(["shell", "pidof", game], { stdio: ["ignore", "pipe", "pipe"] }).trim();
      assert.equal(pids, "", "The game is already running outside this probe");
    } catch (error) {
      if (error.status !== 1 || error.stdout?.toString().trim()) throw error;
    }
  }
  if (mode === "start") {
    writeFileSync(backupFile, JSON.stringify(initial, null, 2) + "\n");
    await page.getByRole("button", { name: zh ? "后台启动游戏" : "Start game in background", exact: true }).filter({ visible: true }).click();
    const started = Date.now();
    while (!(await display()).active) {
      assert.ok(Date.now() - started < 30000, "The virtual display did not become active");
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(3000);
  }
  if (mode === "close") {
    assert.ok(existsSync(backupFile));
    const backup = JSON.parse(readFileSync(backupFile));
    assert.equal(initial.id, backup.id);
    // Use the production overlay handler to clear the frontend session binding too.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("android-game-action", { detail: "close" })));
    await page.getByRole("button", { name: zh ? "后台启动游戏" : "Start game in background", exact: true }).filter({ visible: true }).waitFor();
    await invoke("android_cleanup_scrcpy_virtual_display", { serial: "auto" });
    assert.equal((await display()).active, false);
    await page.evaluate(({ id, fields }) => window.__docsGameProbeStore.getState().modify(id + "::config", fields), backup);
    await page.waitForFunction(({ id, fields }) => Object.entries(fields).every(([key, value]) => JSON.stringify(window.__docsGameProbeStore.getState().configStore[id][key]) === JSON.stringify(value)), backup);
    const final = await attach();
    assert.deepEqual(final.configs, backup.configs);
    assert.deepEqual(final.events, backup.events);
    let gamePids = "";
    try { gamePids = adb(["shell", "pidof", game], { stdio: ["ignore", "pipe", "pipe"] }).trim(); }
    catch (error) { if (error.status !== 1 || error.stdout?.toString().trim()) throw error; }
    assert.equal(gamePids, "", "Restore the game to its initially stopped state before accepting this probe");
    writeFileSync(path.join(cache, "restored.json"), JSON.stringify({ checkedAt: new Date().toISOString(), harnessSha256, fieldsRestored: true, profilesUnchanged: true, eventsUnchanged: true, displayInactive: true, homePlayVisible: true, gameStopped: true, cleanupPath: "production overlay event handler, dispatched by probe; idempotent native cleanup" }, null, 2) + "\n");
  }
  const status = await display();
  const metadata = { checkedAt: new Date().toISOString(), harnessSha256, sourceRevision: proof.sourceRevision, label, mode, package: pkg, game, apkSha256: proof.apkSha256.toLowerCase(),
    display: { active: status.active, displayId: status.displayId, mode: status.mode }, screenshots: [] };
  if (status.active) {
    const shot = await invoke("android_game_screenshot", { request: { packageName: game } });
    const png = Buffer.from(shot.pngBase64, "base64");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    writeFileSync(path.join(cache, label + "-game.png"), png);
    metadata.screenshots.push({ kind: "native-game", sha256: sha(png), width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
  }
  const screen = adb(["exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(path.join(cache, label + "-device.png"), screen);
  metadata.screenshots.push({ kind: "device", sha256: sha(screen) });
  const activities = adb(["shell", "dumpsys", "activity", "activities"]);
  writeFileSync(path.join(cache, label + "-activities.txt"), activities);
  writeFileSync(path.join(cache, label + "-displays.txt"), adb(["shell", "dumpsys", "display"]));
  writeFileSync(path.join(cache, label + "-shell-package.txt"), adb(["shell", "dumpsys", "package", "com.android.shell"]));
  writeFileSync(path.join(cache, label + "-game-package.txt"), adb(["shell", "dumpsys", "package", game]));
  writeFileSync(path.join(cache, label + "-logcat.txt"), adb(["logcat", "-d", "-v", "threadtime", "-t", "4000"], { maxBuffer: 16 * 1024 * 1024 }));
  writeFileSync(path.join(cache, label + ".json"), JSON.stringify(metadata, null, 2) + "\n");
  console.log(JSON.stringify(metadata));
} finally {
  for (const page of browser.contexts().flatMap((context) => context.pages()))
    if (page.url() === "http://tauri.localhost/") await page.evaluate(() => { delete window.__docsGameProbeStore; }).catch(() => {});
  await browser.close();
}
