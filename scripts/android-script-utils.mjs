import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const androidRoot = path.join(repoRoot, "src-tauri", "gen", "android");

export function normalizeArgPath(value) {
  if (process.platform === "win32" && value.startsWith("/") && /^\/[A-Za-z]:\//.test(value)) {
    return value.slice(1);
  }
  return value;
}

export function parseArgs(argv, spec = {}) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (spec.boolean?.includes(key)) {
      result[key] = true;
    } else {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for --${raw.slice(2)}`);
      }
      result[key] = value;
      i += 1;
    }
  }
  return result;
}

export function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
    shell: false,
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(options.errorMessage ?? `${command} ${args.join(" ")} failed with ${result.status}`);
  }
  return result;
}

export function output(command, args = [], options = {}) {
  const result = run(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.stdout.trim();
}

export function commandExists(command) {
  const probe = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  return spawnSync(probe, args, {
    stdio: "ignore",
    shell: process.platform !== "win32",
    windowsHide: true,
  }).status === 0;
}

export function ensureInside(parent, child, label) {
  const resolvedParent = fs.realpathSync(parent);
  const resolvedChild = fs.existsSync(child)
    ? fs.realpathSync(child)
    : path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to touch ${label} outside repo: ${resolvedChild}`);
  }
}

export function removeInside(parent, target, label) {
  if (!fs.existsSync(target)) return;
  ensureInside(parent, target, label);
  fs.rmSync(target, { recursive: true, force: true });
}

export function copyDirContents(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source)) {
    fs.cpSync(path.join(source, entry), path.join(target, entry), {
      recursive: true,
      force: true,
    });
  }
}

export function findNewestDirectory(root, predicate = () => true) {
  if (!fs.existsSync(root)) return null;
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && predicate(entry.name))
    .map((entry) => {
      const fullPath = path.join(root, entry.name);
      return { fullPath, name: entry.name, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.name.localeCompare(a.name) || b.mtimeMs - a.mtimeMs);
  return entries[0]?.fullPath ?? null;
}

export function ensureJavaHome() {
  if (!process.env.JAVA_HOME && process.platform === "win32") {
    const root = "C:\\Program Files\\Eclipse Adoptium";
    const jdk = findNewestDirectory(root, (name) => name.startsWith("jdk-"));
    if (jdk) process.env.JAVA_HOME = jdk;
  }
  if (!process.env.JAVA_HOME) {
    throw new Error("JAVA_HOME is not set. Install JDK 17+ or set JAVA_HOME before building Android.");
  }
  process.env.PATH = `${path.join(process.env.JAVA_HOME, "bin")}${path.delimiter}${process.env.PATH}`;
}

export function ensureAndroidHome() {
  if (!process.env.ANDROID_HOME) {
    const defaults = [];
    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
      defaults.push(path.join(process.env.LOCALAPPDATA, "Android", "Sdk"));
    } else {
      defaults.push(path.join(os.homedir(), "Android", "Sdk"));
      defaults.push(path.join(os.homedir(), "Library", "Android", "sdk"));
    }
    const sdk = defaults.find((candidate) => fs.existsSync(candidate));
    if (sdk) process.env.ANDROID_HOME = sdk;
  }
  if (!process.env.ANDROID_HOME) {
    throw new Error("ANDROID_HOME is not set. Install Android SDK or set ANDROID_HOME before building Android.");
  }
  process.env.ANDROID_SDK_ROOT = process.env.ANDROID_HOME;
  fs.writeFileSync(
    path.join(androidRoot, "local.properties"),
    `sdk.dir=${process.env.ANDROID_HOME.replaceAll("\\", "/")}\n`,
    "ascii",
  );
}

export function newestNdkRoot() {
  const ndkRoot = findNewestDirectory(path.join(process.env.ANDROID_HOME, "ndk"));
  if (!ndkRoot) throw new Error("Android NDK is required to build Rust Android native dependencies.");
  return ndkRoot;
}

export function ndkPrebuiltRoot(ndkRoot) {
  const root = path.join(ndkRoot, "toolchains", "llvm", "prebuilt");
  if (!fs.existsSync(root)) throw new Error(`Missing Android NDK LLVM prebuilt directory: ${root}`);
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
  const preferred = {
    win32: "windows-x86_64",
    linux: "linux-x86_64",
    darwin: process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64",
  }[process.platform];
  const selected = entries.find((entry) => path.basename(entry) === preferred) ?? entries[0];
  if (!selected) throw new Error(`No Android NDK LLVM prebuilt toolchain found under ${root}`);
  return selected;
}

export function exe(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

export function prependPath(...entries) {
  process.env.PATH = `${entries.filter(Boolean).join(path.delimiter)}${path.delimiter}${process.env.PATH}`;
}

export function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function spawnLongRunning(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "ignore",
    detached: process.platform !== "win32",
    windowsHide: true,
  });
}

export function killProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}
