import { spawn } from "node:child_process";
import net from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const devServerPort = 8191;
const args = process.argv.slice(2);
const options = {
  out: path.join(root, "benchmarks", `webview-copy-${Date.now()}.json`),
  sizes: "1024,65536,1048576",
  iterations: "60",
  timeoutMs: "180000",
};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const next = args[index + 1];
  if (arg === "--out" && next) {
    options.out = path.resolve(root, next);
    index += 1;
  } else if (arg === "--sizes" && next) {
    options.sizes = next;
    index += 1;
  } else if (arg === "--iterations" && next) {
    options.iterations = next;
    index += 1;
  } else if (arg === "--timeout-ms" && next) {
    options.timeoutMs = next;
    index += 1;
  } else {
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGTERM");
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isPortOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for dev server on 127.0.0.1:${port}`);
}

function spawnChild(command, commandArgs, env = {}) {
  return spawn(command, commandArgs, {
    cwd: root,
    env: { ...process.env, ...env },
    shell: false,
    stdio: "inherit",
  });
}

async function waitForExit(child, label, timeoutMs) {
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.error(`${label} timed out after ${timeoutMs} ms`);
      killProcessTree(child);
      resolve(124);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      console.error(`Failed to start ${label}: ${error}`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

await mkdir(path.dirname(options.out), { recursive: true });

if (await isPortOpen(devServerPort)) {
  throw new Error(`Port ${devServerPort} is already in use; stop the existing Tauri dev server first`);
}

console.log(`Starting Tauri dev server on 127.0.0.1:${devServerPort}`);
const devServer = spawnChild(process.execPath, ["dev:tauri"]);
try {
  await waitForPort(devServerPort, 60_000);

  console.log(`Starting Tauri WebView copy benchmark; report will be written to ${options.out}`);
  const timeoutMs = Number.parseInt(options.timeoutMs, 10);
  const app = spawnChild("cargo", ["run", "-p", "baas-tauri", "--bin", "baas-tauri"], {
    BAAS_WEBVIEW_COPY_BENCHMARK_OUT: options.out,
    BAAS_WEBVIEW_COPY_BENCHMARK_SIZES: options.sizes,
    BAAS_WEBVIEW_COPY_BENCHMARK_ITERATIONS: options.iterations,
    BAAS_WEBVIEW_COPY_BENCHMARK_TIMEOUT_MS: options.timeoutMs,
  });
  const runCode = await waitForExit(app, "cargo run -p baas-tauri --bin baas-tauri", timeoutMs);

  let report;
  try {
    report = JSON.parse(await readFile(options.out, "utf8"));
  } catch (error) {
    throw new Error(`Benchmark report was not written to ${options.out}: ${error}`);
  }

  if (runCode === 124) {
    throw new Error(`Tauri benchmark process timed out after ${timeoutMs} ms`);
  }
  if (!report.success) {
    throw new Error(`WebView copy benchmark failed: ${report.error ?? "unknown error"}`);
  }
  if (runCode !== 0) {
    throw new Error(`Tauri benchmark process exited with code ${runCode}`);
  }

  console.log(`WebView copy benchmark report: ${options.out}`);
  console.table(
    report.results.map((result) => ({
      bytes: result.payloadSize,
      iterations: result.iterations,
      rustEmitMs: result.rustEmitMs.toFixed(3),
      webviewWallMs: result.webviewWallMs.toFixed(3),
      webviewMiBs: result.webviewMiBs.toFixed(2),
    }))
  );
} finally {
  killProcessTree(devServer);
}
