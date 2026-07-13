import fs from "node:fs";
import path from "node:path";
import {
  androidRoot,
  ensureAndroidHome,
  ensureJavaHome,
  killProcessTree,
  output,
  parseArgs,
  repoRoot,
  run,
  shQuote,
  spawnLongRunning,
} from "./android-script-utils.mjs";

const args = parseArgs(process.argv.slice(2), {
  boolean: ["installShell", "noLaunch", "keepMarker", "dryRun"],
});

ensureJavaHome();
ensureAndroidHome();

const device = args.device ?? process.env.BAAS_ANDROID_DEVICE ?? selectDevice();
const devUrl = args.devUrl ?? "http://127.0.0.1:8191";
const abi = args.abi ?? "x86_64";
const packageName = "io.github.kiramei.baas_tauri";

if (!device) {
  throw new Error("No Android device is connected. Start an emulator or pass --device <serial>.");
}

run("adb", ["-s", device, "reverse", "tcp:8191", "tcp:8191"], {
  stdio: "ignore",
  errorMessage: "Failed to configure adb reverse for Android HMR.",
});
console.log(`Android frontend HMR: device ${device} -> host ${devUrl}`);

if (args.dryRun) {
  console.log("Dry run complete.");
  process.exit(0);
}

if (args.installShell) {
  if (args.backendSource) process.env.BAAS_ANDROID_BACKEND_SRC = args.backendSource;
  run("bun", ["scripts/android-build-debug.mjs", "--skip-web-build", "--abi", abi], {
    errorMessage: "Failed to build Android debug shell.",
  });
  const apk = path.join(
    androidRoot,
    "app",
    "build",
    "outputs",
    "apk",
    abi,
    "debug",
    `app-${abi}-debug.apk`,
  );
  run("adb", ["-s", device, "install", "-r", "-d", apk], {
    errorMessage: "Failed to install Android debug APK.",
  });
}

const logDir = path.join(repoRoot, ".cache");
fs.mkdirSync(logDir, { recursive: true });
const viteOut = path.join(logDir, "android-vite-hot.log");
const viteErr = path.join(logDir, "android-vite-hot.err");
fs.rmSync(viteOut, { force: true });
fs.rmSync(viteErr, { force: true });

function selectDevice() {
  const lines = output("adb", ["devices"], { stdio: ["ignore", "pipe", "pipe"] })
    .split(/\r?\n/)
    .filter((line) => /\tdevice$/.test(line));
  const preferred = lines.find((line) => line.startsWith("emulator-5556\t"));
  return (preferred ?? lines[0])?.split("\t")[0] ?? "";
}

function setAndroidDevUrlMarker() {
  fs.writeFileSync(path.join(logDir, "baas-tauri-dev-url.txt"), devUrl, "ascii");
  run(
    "adb",
    [
      "-s",
      device,
      "shell",
      "run-as",
      packageName,
      "sh",
      "-c",
      `printf %s ${shQuote(devUrl)} > files/baas-tauri-dev-url.txt`,
    ],
    {
      errorMessage: "Failed to write dev URL marker. Install a debug APK first, or rerun with --install-shell.",
    },
  );
}

function clearAndroidDevUrlMarker() {
  try {
    run(
      "adb",
      ["-s", device, "shell", "run-as", packageName, "rm", "-f", "files/baas-tauri-dev-url.txt"],
      { stdio: "ignore" },
    );
  } catch {
    // Debug marker cleanup should not hide the original dev-server error.
  }
}

async function waitForVite(child) {
  for (let i = 0; i < 80; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(devUrl, { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) return;
    } catch {
      // Keep polling until the process exits or the timeout expires.
    }
  }
  const stdout = fs.existsSync(viteOut) ? fs.readFileSync(viteOut, "utf8") : "";
  const stderr = fs.existsSync(viteErr) ? fs.readFileSync(viteErr, "utf8") : "";
  throw new Error(`Vite Android dev server did not become ready.\n${stdout}\n${stderr}`);
}

const stdout = fs.openSync(viteOut, "a");
const stderr = fs.openSync(viteErr, "a");
const vite = spawnLongRunning("bun", ["dev:android"], {
  cwd: repoRoot,
  stdio: ["ignore", stdout, stderr],
});

const cleanup = () => {
  killProcessTree(vite);
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  if (!args.keepMarker) clearAndroidDevUrlMarker();
};
process.once("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.once("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

try {
  await waitForVite(vite);
  if (!args.noLaunch) {
    setAndroidDevUrlMarker();
    run("adb", ["-s", device, "shell", "am", "force-stop", packageName], { stdio: "ignore" });
    run(
      "adb",
      ["-s", device, "shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"],
      { stdio: "ignore" },
    );
    if (!args.keepMarker) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      clearAndroidDevUrlMarker();
    }
  } else if (args.keepMarker) {
    setAndroidDevUrlMarker();
  }

  console.log(`Hot dev is running at ${devUrl}.`);
  console.log(`Vite logs: ${viteOut}`);
  console.log("Press Ctrl+C to stop the dev server.");
  await new Promise((resolve) => vite.once("exit", resolve));
} finally {
  cleanup();
}
