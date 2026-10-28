import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs, repoRoot } from "./android-script-utils.mjs";

const args = parseArgs(process.argv.slice(2), { boolean: ["exerciseVirtualDisplay"] });
const packageName = args.packageName ?? "io.github.kiramei.baas_tauri";
const timeoutMs = Number(args.timeout ?? 30_000);
const hostPort = Number(args.hostPort ?? 18_190);

function adb(device, commandArgs, options = {}) {
  const result = spawnSync("adb", ["-s", device, ...commandArgs], {
    encoding: options.binary ? null : "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(result.stderr?.toString().trim() || `adb ${commandArgs.join(" ")} failed`);
  }
  return result.stdout;
}

function connectedDevices() {
  const result = spawnSync("adb", ["devices"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "adb devices failed");
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => /\tdevice$/.test(line))
    .map((line) => line.split("\t", 1)[0]);
}

function selectDevice() {
  if (args.device || process.env.BAAS_ANDROID_DEVICE) {
    return args.device ?? process.env.BAAS_ANDROID_DEVICE;
  }
  const devices = connectedDevices();
  return (
    devices.find((device) =>
      adb(device, ["shell", "pm", "path", packageName], { allowFailure: true }).includes("package:")
    ) ?? devices[0]
  );
}

function totalPssKb(meminfo) {
  const match = /^\s*TOTAL PSS:\s*(\d+)/m.exec(meminfo);
  return match ? Number(match[1]) : null;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check, waitMs = 20_000) {
  const started = performance.now();
  while (performance.now() - started < waitMs) {
    const value = await check();
    if (value) return value;
    await delay(300);
  }
  return null;
}

function displayForPackage(activityDump, gamePackages) {
  let displayId = null;
  for (const line of activityDump.split(/\r?\n/)) {
    const displayMatch = /^Display #(\d+)/.exec(line.trim());
    if (displayMatch) displayId = Number(displayMatch[1]);
    if (displayId !== null && gamePackages.some((name) => line.includes(name))) return displayId;
  }
  return null;
}

function rootTaskForPackage(stackDump, packageName) {
  let rootTaskId = null;
  for (const line of stackDump.split(/\r?\n/)) {
    const rootMatch = /^RootTask id=(\d+)/.exec(line.trim());
    if (rootMatch) {
      rootTaskId = Number(rootMatch[1]);
      continue;
    }
    if (rootTaskId !== null && line.includes(packageName)) return rootTaskId;
  }
  return null;
}

const device = selectDevice();
if (!device) throw new Error("No Android device is connected.");
const activityComponent = adb(device, [
  "shell",
  "cmd",
  "package",
  "resolve-activity",
  "--brief",
  "-c",
  "android.intent.category.LAUNCHER",
  packageName,
])
  .trim()
  .split(/\r?\n/)
  .at(-1);
if (!activityComponent?.includes("/")) {
  throw new Error(`Unable to resolve launcher activity for ${packageName}`);
}

adb(device, ["forward", `tcp:${hostPort}`, "tcp:8190"]);
adb(device, ["shell", "am", "force-stop", packageName]);
if (args.exerciseVirtualDisplay) {
  adb(device, ["shell", "settings", "delete", "global", "overlay_display_devices"], {
    allowFailure: true,
  });
}
adb(device, ["logcat", "-c"]);

const startedAt = performance.now();
const launchOutput = adb(device, ["shell", "am", "start", "-W", "-n", activityComponent]);
let health = null;
let backendReadyMs = null;
while (performance.now() - startedAt < timeoutMs) {
  try {
    const response = await fetch(`http://127.0.0.1:${hostPort}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) {
      health = await response.json();
      backendReadyMs = Math.round(performance.now() - startedAt);
      break;
    }
  } catch {
    // The embedded backend is still starting.
  }
  await delay(250);
}

let wikiBackendRoutesPresent = null;
try {
  const response = await fetch(`http://127.0.0.1:${hostPort}/openapi.json`, {
    signal: AbortSignal.timeout(2_000),
  });
  const spec = await response.json();
  wikiBackendRoutesPresent = Object.keys(spec.paths ?? {}).some((route) =>
    route.startsWith("/android/wiki")
  );
} catch {
  wikiBackendRoutesPresent = true;
}

const processes = adb(device, ["shell", "ps", "-A"])
  .split(/\r?\n/)
  .filter((line) => line.includes(packageName));
const memory = Object.fromEntries(
  processes.map((line) => {
    const fields = line.trim().split(/\s+/);
    const pid = fields[1];
    const name = fields.at(-1);
    const meminfo = adb(device, ["shell", "dumpsys", "meminfo", pid], { allowFailure: true });
    return [name, { pid: Number(pid), totalPssKb: totalPssKb(meminfo) }];
  })
);

const screenshotPath = path.resolve(
  args.output ?? path.join(repoRoot, ".cache", "android-smoke.png")
);
fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
// Give React one frame budget plus the reconnect/navigation transition after
// backend readiness so the captured image represents the settled UI.
await delay(1_500);
fs.writeFileSync(screenshotPath, adb(device, ["exec-out", "screencap", "-p"], { binary: true }));

const activityState = adb(device, ["shell", "dumpsys", "activity", "activities"]);
const physicalSize = /Physical size:\s*(\d+)x(\d+)/.exec(adb(device, ["shell", "wm", "size"]));
const portraitLocked =
  Number(physicalSize?.[1] ?? 0) < Number(physicalSize?.[2] ?? 0) &&
  activityState.includes(activityComponent) &&
  activityState.includes("SCREEN_ORIENTATION_PORTRAIT");
const wikiChunkPresent = fs
  .readdirSync(path.join(repoRoot, "dist", "assets"))
  .some((name) => /^WikiPage-.*\.js$/.test(name));

let virtualDisplay = null;
if (args.exerciseVirtualDisplay) {
  const gamePackages = [
    "com.RoamingStar.BlueArchive",
    "com.RoamingStar.BlueArchive.bilibili",
    "com.nexon.bluearchive",
    "com.nexon.bluearchiveteen",
    "com.nexon.bluearchiveone",
    "com.YostarJP.BlueArchive",
  ];
  const size = physicalSize
    ? { width: Number(physicalSize[1]), height: Number(physicalSize[2]) }
    : { width: 720, height: 1280 };
  adb(device, [
    "shell",
    "input",
    "tap",
    String(Math.round(size.width * 0.9)),
    String(Math.round(size.height * 0.108)),
  ]);
  const displayState = await waitFor(() => {
    const value = adb(device, [
      "shell",
      "settings",
      "get",
      "global",
      "overlay_display_devices",
    ]).trim();
    const marker = adb(
      device,
      [
        "shell",
        "cat",
        `/storage/emulated/0/Android/data/${packageName}/config/scrcpy_display_id.txt`,
      ],
      { allowFailure: true }
    )
      .trim()
      .match(/^\d+$/)?.[0];
    if (marker) {
      const shellRequest = adb(
        device,
        [
          "shell",
          "test",
          "-f",
          `/storage/emulated/0/Android/data/${packageName}/config/shell_virtual_display.request`,
          "&&",
          "echo",
          "yes",
        ],
        { allowFailure: true }
      );
      return {
        mode: shellRequest.includes("yes") ? "shell-headless" : "native-headless",
        overlaySetting: null,
        displayId: Number(marker),
      };
    }
    if (value && value !== "null") {
      return { mode: "overlay", overlaySetting: value, displayId: null };
    }
    return null;
  });
  const gameDisplayId = await waitFor(() =>
    displayForPackage(adb(device, ["shell", "dumpsys", "activity", "activities"]), gamePackages)
  );
  const observeRunningStatus = () => waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) return null;
      const currentHealth = await response.json();
      return Object.values(currentHealth.statuses ?? {}).find((status) => status?.running) ?? null;
    } catch {
      return null;
    }
  });
  let runningStatus = await observeRunningStatus();
  // The first press also boots the game and can finish a very short scheduler
  // attempt while the splash screen is still settling. Exercise the real
  // scheduler again after the virtual display is established.
  if (!runningStatus && displayState) {
    adb(device, [
      "shell",
      "input",
      "tap",
      String(Math.round(size.width * 0.9)),
      String(Math.round(size.height * 0.108)),
    ]);
    runningStatus = await observeRunningStatus();
  }

  let previewFrameAvailable = false;
  try {
    const response = await fetch(`http://127.0.0.1:${hostPort}/android/virtual-display/frame`, {
      signal: AbortSignal.timeout(5_000),
    });
    const frame = Buffer.from(await response.arrayBuffer());
    previewFrameAvailable =
      response.ok && frame.length > 1_000 && frame[0] === 0xff && frame[1] === 0xd8;
  } catch {
    previewFrameAvailable = false;
  }

  // Removing the phone task models swiping the app away from Recents and
  // deterministically exercises the foreground service's onTaskRemoved cleanup.
  const appRootTask = rootTaskForPackage(
    adb(device, ["shell", "cmd", "activity", "stack", "list"]),
    packageName
  );
  if (appRootTask !== null) {
    adb(device, ["shell", "cmd", "activity", "stack", "remove", String(appRootTask)]);
  } else {
    adb(device, ["shell", "input", "-d", "0", "keyevent", "KEYCODE_BACK"]);
  }
  const cleanedAfterExit = Boolean(
    await waitFor(() => {
      const value = adb(device, [
        "shell",
        "settings",
        "get",
        "global",
        "overlay_display_devices",
      ]).trim();
      const marker = adb(
        device,
        [
          "shell",
          "cat",
          `/storage/emulated/0/Android/data/${packageName}/config/scrcpy_display_id.txt`,
        ],
        { allowFailure: true }
      ).trim();
      const shellRequestPresent = adb(
        device,
        [
          "shell",
          "test",
          "-f",
          `/storage/emulated/0/Android/data/${packageName}/config/shell_virtual_display.request`,
          "&&",
          "echo",
          "yes",
        ],
        { allowFailure: true }
      ).includes("yes");
      const trustedDisplayPresent = adb(device, ["shell", "dumpsys", "display"]).includes(
        "BAAS trusted automation"
      );
      return (value === "null" || value === "") &&
        marker === "" &&
        !shellRequestPresent &&
        !trustedDisplayPresent
        ? true
        : null;
    })
  );
  virtualDisplay = {
    mode: displayState?.mode ?? null,
    overlaySetting: displayState?.overlaySetting ?? null,
    requestedDisplayId: displayState?.displayId ?? null,
    gameDisplayId,
    gameStartedOffPhysicalDisplay: Number(gameDisplayId) > 0,
    schedulerRunningObserved: Boolean(runningStatus),
    previewFrameAvailable,
    runningConfigId: runningStatus?.config_id ?? null,
    cleanedAfterExit,
  };
}

const logcat = adb(device, ["logcat", "-d", "-v", "brief"]);
const fatalLines = logcat
  .split(/\r?\n/)
  .filter(
    (line) =>
      line.includes("FATAL EXCEPTION") ||
      line.includes("Python backend bootstrap failed") ||
      line.includes("UnidentifiedImageError") ||
      line.includes("Android screencap returned invalid PNG data") ||
      line.includes("All activities stopped. Require human take over.")
  );
const totalTime = Number(/TotalTime:\s*(\d+)/.exec(launchOutput)?.[1] ?? 0);
const result = {
  ok:
    health?.ok === true &&
    fatalLines.length === 0 &&
    portraitLocked &&
    !wikiChunkPresent &&
    wikiBackendRoutesPresent === false &&
    (!virtualDisplay ||
      (Boolean(virtualDisplay.mode) &&
        (virtualDisplay.mode !== "overlay" || Boolean(virtualDisplay.overlaySetting)) &&
        virtualDisplay.gameStartedOffPhysicalDisplay &&
        virtualDisplay.schedulerRunningObserved &&
        virtualDisplay.previewFrameAvailable &&
        virtualDisplay.cleanedAfterExit)),
  device,
  activityDisplayedMs: totalTime,
  backendReadyMs,
  healthOk: Boolean(health?.ok),
  portraitLocked,
  wikiRemovedFromAndroidBundle: !wikiChunkPresent,
  wikiRemovedFromAndroidBackend: wikiBackendRoutesPresent === false,
  virtualDisplay,
  memory,
  fatalLines,
  screenshotPath,
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
