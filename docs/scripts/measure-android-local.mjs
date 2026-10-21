import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({ options: { serial: { type: "string" }, "native-root": { type: "string" }, probe: { type: "boolean", default: false } } });
assert.ok(values.serial, "An explicit device serial is required");
const native = path.resolve(values["native-root"] || path.join(root, "../baas-docs-android-validation"));
const pkg = "io.github.kiramei.baas_tauri.docs.x86", fixture = "io.github.kiramei.baas_docs_benchmark";
const game = "com.RoamingStar.BlueArchive.bilibili";
const expectedApk = "b1324e14ffda8e5a4a92f726232fdf29f8af7b5021f85f0f1cb8e09097dde321";
const expectedRevision = "36f08fd35535dccf80b4c51c56da8d33b4201823";
const expectedFixture = JSON.parse(readFileSync(path.join(root, "docs/public/benchmarks/device-current.json"))).targetApkSha256;
const session = randomUUID();
const cache = path.join(root, ".cache/android-local-benchmark", session);
mkdirSync(cache, { recursive: true });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const adb = (args, options = {}) => execFileSync("adb", ["-s", values.serial, ...args],
  { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024, ...options });
const text = args => adb(args).toString().trim();
const git = args => execFileSync("git", args, { cwd: native, encoding: "utf8", windowsHide: true }).trim();
const runAs = args => adb(["exec-out", "run-as", pkg, ...args]);
const exists = name => {
  try { adb(["shell", "run-as", pkg, "test", "-e", name]); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
};
const pid = name => {
  try { return text(["shell", "pidof", name]); }
  catch (error) { if (error.status === 1) return ""; throw error; }
};
const apkHash = name => {
  const file = text(["shell", "pm", "path", name]).replace(/^package:/, "");
  assert.match(file, /^\/data\/app\/[a-zA-Z0-9_./~+=-]+\/base\.apk$/);
  return text(["shell", "sha256sum", file]).split(/\s+/)[0];
};
const sharedShizuku = () => text(["shell", "ps", "-A", "-o", "USER,PID,NAME"])
  .split(/\r?\n/).filter(line => line.trim().endsWith(" shizuku_server")).map(line => line.trim());

let browser, page, baseline, uiBefore, token, original, instrumented, remoteDirectory, remoteTemp;
let hookInstalled = false, directoryCreated = false, workerResult, restoration, failure;
const report = { session, probe: values.probe, startedAt: new Date().toISOString(), apkSha256: expectedApk, sourceRevision: expectedRevision,
  targetApkSha256: expectedFixture, instrumentation: "Temporary service-package startup hook; production adapter methods are unchanged", phases: [] };
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const display = () => invoke("android_scrcpy_virtual_display_status", { serial: "auto" });
const readUi = () => JSON.parse(runAs(["cat", "files/baas/.app_storage.json"]).toString()).uiSettings;

async function connect() {
  const current = pid(pkg);
  assert.match(current, /^\d+$/);
  assert.equal(text(["shell", "cat", `/proc/${current}/cmdline`]).replaceAll("\0", ""), pkg);
  adb(["forward", "tcp:19233", `localabstract:webview_devtools_remote_${current}`]);
  browser = await chromium.connectOverCDP("http://127.0.0.1:19233", { noDefaults: true });
  page = browser.contexts().flatMap(context => context.pages()).find(page => page.url() === "http://tauri.localhost/");
  assert.ok(page);
  page.setDefaultTimeout(20000);
  await ensureStore();
  await sleep(2000);
  await ensureStore();
}

async function ensureStore() {
  await page.waitForFunction(async () => {
    const urls = performance.getEntriesByType("resource").map(entry => entry.name)
      .filter(url => url.startsWith(location.origin + "/assets/WebsocketStore-") && url.endsWith(".js"));
    const stores = new Set();
    for (const url of new Set(urls)) for (const value of Object.values(await import(url))) {
      if (typeof value?.getState === "function" && value.getState()._all_data_initialized && value.getState()._auth_phase === "authenticated") stores.add(value);
    }
    if (stores.size !== 1) return false;
    window.__androidLocalMeasureStore = [...stores][0];
    return true;
  }, null, { timeout: 60000 });
}

async function state() {
  await ensureStore();
  return page.evaluate(() => {
    const s = window.__androidLocalMeasureStore.getState();
    if (Object.values(s.statusStore).some(status => status.running) || Object.values(s.configStore).some(config => config.autostart))
      throw Error("A task or autostart is active");
    const demo = Object.entries(s.configStore).filter(([, config]) => config.name === "Documentation Demo");
    if (demo.length !== 1 || demo[0][1].server !== "B服" || s.eventStore[demo[0][0]].length !== 26 || s.eventStore[demo[0][0]].some(event => event.enabled))
      throw Error("The isolated all-disabled demo is unavailable");
    return { id: demo[0][0], configs: s.configStore, events: s.eventStore };
  });
}

const allowedDemoFields = ["adbIP", "adbPort", "control_method", "screenshot_method", "createPriority_phase1", "createPriority_phase2",
  "createPriority_phase3", "create_item_holding_quantity", "_pass"];
async function assertBaseline(allowDemoChanges) {
  const current = await state();
  assert.equal(current.id, baseline.id);
  assert.deepEqual(current.events, baseline.events);
  assert.deepEqual(Object.keys(current.configs).sort(), Object.keys(baseline.configs).sort());
  for (const [id, config] of Object.entries(current.configs)) {
    if (id !== baseline.id || !allowDemoChanges) assert.deepEqual(config, baseline.configs[id]);
    else for (const key of new Set([...Object.keys(config), ...Object.keys(baseline.configs[id])])) {
      if (!allowedDemoFields.includes(key)) assert.deepEqual(config[key], baseline.configs[id][key], `Unexpected demo change: ${key}`);
    }
  }
  return current;
}

async function setAutoUpdate(enabled, restoreSection) {
  await page.getByRole("button", { name: "设置", exact: true }).filter({ visible: true }).click();
  await page.getByRole("combobox", { name: "设置分类", exact: true }).click();
  await page.getByRole("option", { name: "更新", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "空闲时自动更新脚本", exact: true });
  if ((await toggle.getAttribute("aria-checked") === "true") !== enabled) await toggle.click();
  for (let attempt = 0; attempt < 30 && readUi().idleAutoUpdate !== enabled; attempt++) await sleep(200);
  assert.equal(readUi().idleAutoUpdate, enabled);
  if (restoreSection) {
    const dictionary = JSON.parse(readFileSync(path.join(native, "public/locales/zh.json")));
    const label = dictionary.settings.sections[uiBefore.settingsSection || "general"];
    assert.equal(typeof label, "string");
    await page.getByRole("combobox", { name: "设置分类", exact: true }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await sleep(500);
  }
  await page.getByRole("button", { name: "主页", exact: true }).filter({ visible: true }).click();
}

function pushPrivate(local, remote) {
  assert.ok(remote.startsWith("files/.baas-docs-local-measure/") || remote === "files/baas/service/__init__.py");
  adb(["push", local, remoteTemp]);
  adb(["shell", "run-as", pkg, "cp", remoteTemp, remote + ".new"]);
  adb(["shell", "run-as", pkg, "mv", remote + ".new", remote]);
}

async function restartApp() {
  if (browser) await browser.close(); browser = null; page = null;
  adb(["shell", "am", "force-stop", pkg]);
  adb(["shell", "am", "start", "-n", pkg + "/io.github.kiramei.baas_tauri.MainActivity"]);
  await sleep(1500);
  await connect();
}

async function bridge(route, data) {
  const response = await fetch("http://127.0.0.1:12093" + route, { method: data ? "POST" : "GET",
    headers: { "x-baas-token": token, ...(data ? { "content-type": "application/json" } : {}) },
    body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  return response.json();
}

function fixtureState(request) {
  const ready = request.action === "ready";
  const scene = request.action === "scene" || ready;
  const result = text(["shell", "am", "broadcast", "-n", fixture + "/.TargetReceiver", "-a", fixture + ".SET_STATE",
    "--ei", "token", String(ready ? 30000 : scene ? request.token : -1),
    "--ei", "scene", String(ready ? 0 : scene ? request.scene : -1), "--ez", "reset", String(ready || (scene && request.reset))]);
  assert.ok(result.includes("Broadcast completed"));
  return JSON.parse(adb(["exec-out", "run-as", fixture, "cat", "files/state.json"]).toString());
}

try {
  assert.equal(git(["rev-parse", "HEAD"]), expectedRevision);
  assert.equal(git(["status", "--porcelain"]), "");
  assert.equal(apkHash(pkg), expectedApk);
  assert.equal(apkHash(fixture), expectedFixture);
  assert.equal(pid(game), "", "Do not touch an existing game session");
  assert.equal(pid(fixture), "", "Do not touch an existing fixture session");
  const appUid = Number(text(["shell", "cmd", "package", "list", "packages", "-U", pkg]).match(/uid:(\d+)\b/)?.[1]);
  assert.ok(appUid >= 10000);
  const sharedBefore = sharedShizuku();
  assert.equal(sharedBefore.length, 1);
  report.sharedShizukuBefore = sharedBefore;
  report.systemProcessBefore = pid("system_server");
  report.environment = { androidRelease: text(["shell", "getprop", "ro.build.version.release"]),
    apiLevel: Number(text(["shell", "getprop", "ro.build.version.sdk"])),
    deviceAbi: text(["shell", "getprop", "ro.product.cpu.abi"]), model: text(["shell", "getprop", "ro.product.model"]) };
  report.nativeSources = Object.fromEntries([
    "src-tauri/gen/android/app/src/main/python/android_backend/native_device.py",
    "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/BaasLocalDeviceServer.kt",
    "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/ShizukuController.kt",
    "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/ShizukuShellService.kt",
    "src-tauri/gen/android/app/src/main/cpp/display_capture.cpp",
  ].map(file => {
    const current = readFileSync(path.join(native, file)).toString().replaceAll("\r\n", "\n");
    assert.equal(current, execFileSync("git", ["show", expectedRevision + ":" + file], { cwd: native, encoding: "utf8", windowsHide: true }).replaceAll("\r\n", "\n"));
    return [file, hash(current)];
  }));
  remoteDirectory = "files/.baas-docs-local-measure";
  assert.equal(exists(remoteDirectory), false, "Previous instrumentation must be audited, not overwritten");
  remoteTemp = `/data/local/tmp/baas-docs-local-${session}`;
  await connect();
  baseline = await state();
  assert.equal((await display()).active, false);
  const terminal = await invoke("updater_terminal_snapshot");
  assert.ok(Array.isArray(terminal.activeTasks) && terminal.activeTasks.length === 0, "An updater workflow is active");
  uiBefore = readUi();
  assert.equal(uiBefore.lang, "zh");
  assert.ok(["light", "dark"].includes(uiBefore.theme));
  report.environment.uiThemePreference = uiBefore.theme;
  writeFileSync(path.join(cache, "baseline.json"), JSON.stringify({ ...baseline, uiSettings: uiBefore }, null, 2));
  if (uiBefore.idleAutoUpdate !== false) await setAutoUpdate(false, false);
  original = runAs(["cat", "files/baas/service/__init__.py"]);
  assert.ok(!original.toString().includes("_start_baas_docs_local_measurement"));
  const hook = readFileSync(path.join(root, "docs/benchmarks/android-local/service-hook.py"));
  instrumented = Buffer.concat([original, Buffer.from("\n"), hook]);
  writeFileSync(path.join(cache, "service-init-original.py"), original);
  writeFileSync(path.join(cache, "service-init-instrumented.py"), instrumented);
  const worker = path.join(root, "docs/scripts/measure-android-local-worker.py");
  report.harness = Object.fromEntries(["docs/scripts/measure-android-local.mjs", "docs/scripts/measure-android-local-worker.py",
    "docs/benchmarks/android-local/service-hook.py"].map(file => [file, hash(readFileSync(path.join(root, file)).toString().replaceAll("\r\n", "\n"))]));
  report.entrypointOriginalSha256 = hash(original);
  report.entrypointInstrumentedSha256 = hash(instrumented);
  writeFileSync(path.join(cache, "request.json"), JSON.stringify({ session, appUid, probe: values.probe }));
  adb(["shell", "run-as", pkg, "mkdir", remoteDirectory]);
  directoryCreated = true;
  pushPrivate(worker, remoteDirectory + "/worker.py");
  pushPrivate(path.join(cache, "request.json"), remoteDirectory + "/request.json");
  await browser.close(); browser = null; page = null;
  adb(["shell", "am", "force-stop", pkg]);
  assert.equal(hash(runAs(["cat", "files/baas/service/__init__.py"])), hash(original));
  hookInstalled = true;
  pushPrivate(path.join(cache, "service-init-instrumented.py"), "files/baas/service/__init__.py");
  adb(["shell", "am", "start", "-n", pkg + "/io.github.kiramei.baas_tauri.MainActivity"]);
  await sleep(1500);
  await connect();
  await assertBaseline(true);
  assert.equal(readUi().idleAutoUpdate, false);
  await page.locator(`[id='tab-${baseline.id}']`).filter({ visible: true }).click();
  await page.getByRole("button", { name: "主页", exact: true }).filter({ visible: true }).click();
  await page.getByRole("button", { name: "后台启动游戏", exact: true }).click();
  let currentDisplay;
  for (let attempt = 0; attempt < 80; attempt++) {
    currentDisplay = await display();
    if (currentDisplay.active && currentDisplay.displayId > 0) break;
    await sleep(250);
  }
  assert.ok(currentDisplay.active && currentDisplay.displayId > 0);
  report.displayId = currentDisplay.displayId;
  adb(["forward", "tcp:12093", "tcp:7912"]);
  token = runAs(["cat", "files/android-local-device-token"]).toString().trim();
  assert.equal(await (await fetch("http://127.0.0.1:12093/version")).text(), "baas-shizuku-display-1");
  assert.equal((await fetch("http://127.0.0.1:12093/info")).status, 403);
  let gameReady = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if ((await bridge("/info")).currentPackageName === game) { gameReady = true; break; }
    await sleep(250);
  }
  assert.ok(gameReady && /^\d+$/.test(pid(game)));
  adb(["shell", "am", "force-stop", game]);
  assert.equal(pid(game), "");
  const launched = await bridge("/jsonrpc/0", { jsonrpc: "2.0", id: 1, method: "appStart", params: [fixture] });
  assert.equal(launched.result, true);
  for (let attempt = 0; attempt < 80 && (await bridge("/info")).currentPackageName !== fixture; attempt++) await sleep(250);
  assert.equal((await bridge("/info")).currentPackageName, fixture);
  report.backendPid = Number(pid(pkg + ":baas_backend"));
  assert.ok(report.backendPid > 0);
  let lastSequence = 0, lastProgress = "", lastStateCheck = 0;
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    if (Date.now() - lastStateCheck > 2000) { await assertBaseline(true); lastStateCheck = Date.now(); }
    let status;
    try { status = JSON.parse(runAs(["cat", remoteDirectory + "/status.json"]).toString()); }
    catch (error) { if (error.status !== 1) throw error; await sleep(300); continue; }
    assert.equal(status.session, session);
    if (status.resultReady) {
      const bytes = runAs(["cat", remoteDirectory + "/result.json"]);
      writeFileSync(path.join(cache, "worker-result.json"), bytes);
      workerResult = JSON.parse(bytes);
      assert.equal(workerResult.session, session);
      assert.equal(workerResult.runtime?.pid, report.backendPid);
      assert.equal(workerResult.success, true, workerResult.failures?.map(row => row.type + ": " + row.message).join("; "));
      break;
    }
    if (status.phase) {
      const request = status.phase;
      assert.equal(request.session, session);
      if (request.sequence > lastSequence) {
        assert.ok(["ready", "scene", "snapshot"].includes(request.action));
        assert.equal((await bridge("/info")).currentPackageName, fixture);
        const snapshot = fixtureState(request);
        writeFileSync(path.join(cache, "response.json"), JSON.stringify({ session, sequence: request.sequence, ok: true, state: snapshot }));
        pushPrivate(path.join(cache, "response.json"), remoteDirectory + "/response.json");
        report.phases.push({ sequence: request.sequence, action: request.action, token: snapshot.token, inputs: snapshot.inputs,
          durationMs: snapshot.durationMs, travelPixels: snapshot.travelPixels });
        lastSequence = request.sequence;
      }
    }
    const progress = JSON.stringify(status.progress);
    if (progress !== lastProgress) { console.log(progress); lastProgress = progress; }
    await sleep(300);
  }
  assert.ok(workerResult, "On-device worker did not finish before the deadline");
  assert.equal(workerResult.probe, values.probe);
  assert.equal(workerResult.capture.length, values.probe ? 8 : 400);
  assert.equal(workerResult.control.length, values.probe ? 3 : 216);
} catch (error) {
  failure = error;
  report.error = String(error);
} finally {
  try {
    if (hookInstalled) {
      writeFileSync(path.join(cache, "stop.json"), JSON.stringify({ session }));
      pushPrivate(path.join(cache, "stop.json"), remoteDirectory + "/stop.json");
      if (exists(remoteDirectory + "/result.json"))
        writeFileSync(path.join(cache, "worker-result-at-cleanup.json"), runAs(["cat", remoteDirectory + "/result.json"]));
      // Restore disk ownership before waiting for a WebView that may be reloading.
      if (browser) await browser.close(); browser = null; page = null;
      adb(["shell", "am", "force-stop", pkg]);
      const currentHash = hash(runAs(["cat", "files/baas/service/__init__.py"]));
      assert.ok([hash(original), hash(instrumented)].includes(currentHash), "Entrypoint was changed by another owner");
      pushPrivate(path.join(cache, "service-init-original.py"), "files/baas/service/__init__.py");
      assert.equal(hash(runAs(["cat", "files/baas/service/__init__.py"])), hash(original));
      await restartApp();
      await invoke("android_cleanup_scrcpy_virtual_display", { serial: "auto" });
      assert.equal((await display()).active, false);
      assert.equal(pid(game), "");
      assert.equal(pid(fixture), "");
      const current = await assertBaseline(true);
      const changes = Object.fromEntries(allowedDemoFields.filter(key => JSON.stringify(current.configs[baseline.id][key]) !== JSON.stringify(baseline.configs[baseline.id][key]))
        .map(key => [key, baseline.configs[baseline.id][key]]));
      if (Object.keys(changes).length) await page.evaluate(({ id, changes }) => window.__androidLocalMeasureStore.getState().modify(id + "::config", changes), { id: baseline.id, changes });
      for (let attempt = 0; attempt < 40; attempt++) {
        await sleep(250);
        try { await assertBaseline(false); break; } catch (error) { if (attempt === 39) throw error; }
      }
    }
    if (directoryCreated) {
      for (const name of ["worker.py", "request.json", "response.json", "status.json", "result.json", "stop.json"])
        if (exists(remoteDirectory + "/" + name)) adb(["shell", "run-as", pkg, "rm", remoteDirectory + "/" + name]);
      adb(["shell", "run-as", pkg, "rmdir", remoteDirectory]);
    }
    if (uiBefore && browser) {
      await setAutoUpdate(uiBefore.idleAutoUpdate !== false, true);
      assert.deepEqual(readUi(), uiBefore);
      await assertBaseline(false);
    }
    if (baseline) {
      assert.equal((await display()).active, false);
      assert.equal(pid(game), "");
      assert.equal(pid(fixture), "");
      assert.deepEqual(sharedShizuku(), report.sharedShizukuBefore);
      report.systemProcessAfter = pid("system_server");
      assert.equal(report.systemProcessAfter, report.systemProcessBefore);
      assert.equal(git(["rev-parse", "HEAD"]), expectedRevision);
      assert.equal(git(["status", "--porcelain"]), "");
      restoration = { entrypointRestored: !hookInstalled || hash(runAs(["cat", "files/baas/service/__init__.py"])) === hash(original),
        configsUnchanged: true, eventsUnchanged: true, uiSettingsUnchanged: true, displayInactive: true,
        gameStopped: true, fixtureStopped: true, sharedShizukuServerUnchanged: true, systemProcessUnchanged: true, nativeWorktreeUnchanged: true };
    }
  } catch (error) { failure ||= error; report.cleanupError = String(error); }
  if (remoteTemp) adb(["shell", "rm", "-f", remoteTemp]);
  if (browser) { await page.evaluate(() => { delete window.__androidLocalMeasureStore; }).catch(() => {}); await browser.close(); }
  report.finishedAt = new Date().toISOString();
  report.success = !failure && Boolean(workerResult?.success) && Boolean(restoration);
  report.restoration = restoration;
  writeFileSync(path.join(cache, "run.json"), JSON.stringify(report, null, 2));
}
if (failure) throw failure;
console.log(JSON.stringify({ success: report.success, capture: workerResult.capture.length, control: workerResult.control.length,
  backendPid: report.backendPid, restoration, privateEvidence: cache }));
