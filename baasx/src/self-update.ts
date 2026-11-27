import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import manifest from "../package.json";
import { denoPermissionFlags, isStandalone } from "./session";

const repository = "https://github.com/Kiramei/baas-tauri";
const mirror = "https://cnb.cool/kiramei/baas-tauri";
type ReleaseSource = "github" | "cnb";
const releaseBase = (source: ReleaseSource) =>
  source === "github" ? repository + "/releases" : mirror + "/-/releases";
const packageName = "@kiramei/baasx";
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
type Manager = "npm" | "bun" | "pnpm" | "yarn" | "deno" | "cnpm";
type Install =
  | { kind: "package"; manager: Manager; archive: boolean; project?: string; prefix?: string }
  | { kind: "native" }
  | { kind: "source" };
export interface SelfUpdate {
  source?: ReleaseSource;
  current: string;
  latest: string;
  available: boolean;
  notes: string;
  command: string;
  install: Install;
}
const managerArgs: Record<Manager, string[]> = {
  npm: ["install", "-g"],
  bun: ["add", "-g"],
  pnpm: ["add", "-g"],
  cnpm: ["install", "-g"],
  yarn: ["global", "add"],
  deno: ["install", "-g"],
};

export function packageManager(path: string, deno = false): Manager {
  const entry = path.replaceAll("\\", "/").toLowerCase();
  if (deno || /\/(?:deno[/_-]dir|deno)\/npm\//.test(entry)) return "deno";
  if (
    /\/install\/global\//.test(entry) ||
    (process.env.BUN_INSTALL_GLOBAL_DIR &&
      entry.startsWith(
        process.env.BUN_INSTALL_GLOBAL_DIR.replaceAll("\\", "/").toLowerCase() + "/"
      ))
  )
    return "bun";
  if (/\/(?:\.pnpm|\.pnpm-global|pnpm\/global)\//.test(entry)) return "pnpm";
  if (/\/(?:\.config\/yarn|yarn)\/global\//.test(entry)) return "yarn";
  if (/\/(?:_@kiramei_baasx@[^/]+|\.store\/@kiramei\+baasx@[^/]+)\//.test(entry)) return "cnpm";
  return "npm";
}

export function installation(): Install {
  if (isStandalone()) return { kind: "native" };
  const entry = fileURLToPath(import.meta.url);
  // Registry bundles run under Node even when installed by Bun or pnpm.
  // Identify the owning installation from the real bundle path, not the runtime.
  let path = entry;
  try {
    path = realpathSync(entry);
  } catch {
    /* Deno may use a virtual npm path. */
  }
  const normalized = path.replaceAll("\\", "/");
  const archive = normalized.endsWith("/dist/baasx.js");
  if (
    (!archive && !normalized.endsWith("/dist/baasx-node.mjs")) ||
    (!normalized.includes("/node_modules/") && !process.versions.deno)
  )
    return { kind: "source" };
  let manager = packageManager(path, !!process.versions.deno);
  const modules = normalized.indexOf("/node_modules/");
  const root = modules < 0 ? undefined : normalized.slice(0, modules);
  // npm global prefixes end in lib/node_modules on Unix. A local installation
  // must update the project containing the CLI, even when invoked elsewhere.
  if (root && manager !== "deno") {
    if (manager === "npm" && process.platform !== "win32" && root.endsWith("/lib"))
      return { kind: "package", manager, archive, prefix: dirname(root) };
    if (
      !/\/(?:install\/global|pnpm\/global|yarn\/global)(?:\/|$)/i.test(root) &&
      existsSync(join(root, "package.json"))
    ) {
      if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")))
        manager = "bun";
      else if (existsSync(join(root, "yarn.lock"))) manager = "yarn";
      else if (existsSync(join(root, "pnpm-lock.yaml"))) manager = "pnpm";
      return { kind: "package", manager, archive, project: root };
    }
    if (manager === "npm" && process.platform === "win32")
      return { kind: "package", manager, archive, prefix: root };
  }
  return { kind: "package", manager, archive };
}

export function newerStable(candidate: string, current: string): boolean {
  if (!stable.test(candidate)) return false;
  const left = candidate.split("+")[0].split(".").map(BigInt);
  const right = current.split(/[+-]/)[0].split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return current.split("+")[0].includes("-");
}

function releaseTag(version: string) {
  // 0.1.6 was the first BAASX release to drop the v from its tag.
  return newerStable("0.1.6", version) ? `baasx-v${version}` : `baasx-${version}`;
}

function versionFromTag(tag: unknown) {
  if (typeof tag !== "string") return;
  const version = /^baasx-v?(.+)$/.exec(tag)?.[1];
  if (version && stable.test(version) && tag === releaseTag(version)) return version;
}

function platformAsset(version: string) {
  const platform: Record<string, string> = {
    "linux-x64": "Linux-X64",
    "darwin-arm64": "macOS-ARM64",
    "win32-x64": "Windows-X64",
  };
  const label = platform[`${process.platform}-${process.arch}`];
  if (!label) throw new Error(`No BAASX release for ${process.platform}-${process.arch}`);
  return `baasx-${version}-${label}`;
}

async function request(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, headers: { "User-Agent": "baasx-self-update" } });
  if (!response.ok)
    throw new Error(`BAASX update: HTTP ${response.status} (${new URL(url).hostname})`);
  return response;
}

function packageCommand(
  version: string,
  install: Extract<Install, { kind: "package" }>,
  source: ReleaseSource = "github"
) {
  const target = install.archive
    ? `${releaseBase(source)}/download/${releaseTag(version)}/${platformAsset(version)}-bun.tgz`
    : `${install.manager === "deno" ? "npm:" : ""}${packageName}@${version}`;
  const args = install.project
    ? managerArgs[install.manager].filter((arg) => arg !== "-g" && arg !== "global")
    : managerArgs[install.manager];
  return [
    install.manager,
    ...args,
    ...(install.manager === "deno" ? [...denoPermissionFlags(), "--force"] : []),
    target,
  ];
}

async function githubVersion(signal: AbortSignal) {
  let latest: string | undefined;
  let page = 1;
  // BAASX and the desktop app publish independent releases in the same repo.
  for (;;) {
    const data = await (
      await request(
        `https://api.github.com/repos/Kiramei/baas-tauri/releases?per_page=100&page=${page++}`,
        signal
      )
    ).json();
    if (!Array.isArray(data)) throw new Error("Invalid GitHub release response");
    for (const release of data) {
      if (release.draft || release.prerelease) continue;
      const version = versionFromTag(release.tag_name);
      if (version && (!latest || newerStable(version, latest))) latest = version;
    }
    if (data.length < 100) break;
  }
  return latest;
}

// The release workflow pushes BAASX tags and identical assets to CNB. Its
// public Git refs are accessible without a token. Check the manifest as well:
// a tag alone does not mean the native release has finished uploading.
async function mirrorVersion(signal: AbortSignal) {
  const refs = await (
    await request(mirror + ".git/info/refs?service=git-upload-pack", signal)
  ).text();
  const versions = new Set<string>();
  for (const match of refs.matchAll(/ refs\/tags\/(baasx-[0-9A-Za-z.+-]+)(?=\^\{|\s|$)/g)) {
    const version = versionFromTag(match[1]);
    if (version) versions.add(version);
  }
  const descending = [...versions].sort((a, b) =>
    newerStable(a, b) ? -1 : newerStable(b, a) ? 1 : 0
  );
  for (const version of descending) {
    const url = `${releaseBase("cnb")}/download/${releaseTag(version)}/SHA256SUMS`;
    const response = await fetch(url, { signal });
    if (response.status === 404) {
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) throw new Error(`CNB release manifest: HTTP ${response.status}`);
    if ((await response.text()).split(/\s+/).includes(platformAsset(version) + ".tar.gz"))
      return version;
  }
}

export async function checkSelfUpdate(
  install = installation(),
  cancel?: AbortSignal
): Promise<SelfUpdate> {
  if (install.kind === "source")
    throw new Error("This is a source checkout. Update and rebuild it with Git and Bun.");
  const timeout = AbortSignal.timeout(10000);
  const signal = cancel ? AbortSignal.any([cancel, timeout]) : timeout;
  let latest: string | undefined;
  let source: ReleaseSource = "github";
  if (install.kind === "package" && !install.archive) {
    const data = await (
      await request("https://registry.npmjs.org/@kiramei%2fbaasx/latest", signal)
    ).json();
    if (data.name === packageName && typeof data.version === "string" && stable.test(data.version))
      latest = data.version;
  } else {
    try {
      latest = await githubVersion(AbortSignal.any([signal, AbortSignal.timeout(5000)]));
    } catch (error) {
      signal.throwIfAborted();
      source = "cnb";
      latest = await mirrorVersion(signal);
      if (!latest) throw error;
    }
  }
  if (!latest) throw new Error("No stable BAASX release found");
  return {
    current: manifest.version,
    latest,
    available: newerStable(latest, manifest.version),
    notes: `${releaseBase(source)}/tag/${releaseTag(latest)}`,
    source,
    command:
      install.kind === "package"
        ? packageCommand(latest, install, source).join(" ")
        : "baasx self update",
    install,
  };
}

const exec = promisify(execFile);

export async function replaceNative(
  version: string,
  executablePath: string,
  signal: AbortSignal,
  source: ReleaseSource = "github"
) {
  const executable = await realpath(executablePath);
  const root = dirname(executable);
  const nativeName = process.platform === "win32" ? "baasx.exe" : "baasx";
  const helper = process.platform === "win32" ? "baas-cli-runtime.exe" : "baas-cli-runtime";
  const archiveName = `${platformAsset(version)}.tar.gz`;
  // Metadata, checksums and asset redirects may take different network routes.
  async function asset(name: string) {
    const path = `/download/${releaseTag(version)}/${name}`;
    try {
      return await request(releaseBase(source) + path, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (source === "cnb") throw error;
      source = "cnb";
      return request(releaseBase(source) + path, signal);
    }
  }
  const stage = await mkdtemp(join(root, ".baasx-update-"));
  let keepBackup = false;
  try {
    const sums = await (await asset("SHA256SUMS")).text();
    const expected = sums
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+\*?/))
      .find(([, file]) => file === archiveName)?.[0];
    if (!expected || !/^[a-f\d]{64}$/i.test(expected)) throw new Error("Missing release checksum");
    const archive = join(stage, archiveName);
    const response = await asset(archiveName);
    if (!response.body) throw new Error("Empty release archive");
    await pipeline(
      Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(archive),
      { signal }
    );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest("hex") !== expected.toLowerCase())
      throw new Error("BAASX release checksum mismatch");
    const { stdout: listing } = await exec("tar", ["-tzf", archive], { signal });
    const members = new Set(listing.split(/\r?\n/));
    const runtimeName = process.platform === "win32" ? "baasx-runtime.exe" : "baasx-runtime";
    const helpers = [runtimeName, helper]
      .map((name) => "runtime/" + name)
      .filter((name) => members.has(name));
    if (!helpers.length) throw new Error("Missing BAASX runtime helper");
    await exec("tar", ["-xzf", archive, "-C", stage, nativeName, ...helpers], { signal });
    const targets = [
      ...helpers.map((name) => [join(stage, name), join(root, name)]),
      [join(stage, nativeName), executable],
    ];
    for (const [next] of targets) {
      if (!(await lstat(next)).isFile()) throw new Error("Invalid BAASX release member");
      await chmod(next, 0o755);
    }
    signal.throwIfAborted();
    const lock = join(root, ".baasx-replacing");
    await mkdir(lock);
    const moved: Array<[string, string | undefined]> = [];
    try {
      await mkdir(join(root, "runtime"), { recursive: true });
      for (const [next, target] of targets) {
        const backup = join(stage, basename(target) + ".previous");
        try {
          await rename(target, backup);
          moved.push([target, backup]);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          moved.push([target, undefined]);
        }
        await rename(next, target);
      }
    } catch (error) {
      for (const [target, backup] of moved.reverse()) {
        try {
          await rm(target, { force: true });
          if (backup) await rename(backup, target);
        } catch {
          keepBackup = true;
        }
      }
      if (keepBackup)
        throw new Error(`Could not restore the previous release. Its backup is in ${stage}`, {
          cause: error,
        });
      throw error;
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  } finally {
    // Windows may keep a renamed, running image open until the session exits.
    if (!keepBackup) await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

export async function applySelfUpdate(update: SelfUpdate, signal: AbortSignal) {
  if (!update.available || !newerStable(update.latest, manifest.version)) return false;
  if (update.install.kind === "native")
    await replaceNative(update.latest, process.execPath, signal, update.source);
  else if (update.install.kind === "package") {
    const install = update.install;
    const [program, ...args] = packageCommand(update.latest, install, update.source);
    // Windows package managers supply .cmd shims. All arguments here are fixed
    // literals or constructed from a validated release version.
    const shim = process.platform === "win32" && ["npm", "pnpm", "yarn", "cnpm"].includes(program);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        shim ? "cmd.exe" : program,
        shim ? ["/d", "/c", program, ...args] : args,
        {
          signal,
          cwd: install.project,
          env: install.prefix ? { ...process.env, npm_config_prefix: install.prefix } : process.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let tail = "";
      const capture = (chunk: Buffer) => {
        tail = (tail + chunk.toString()).slice(-2000);
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("error", reject);
      child.once("close", (status) =>
        status === 0 ? resolve() : reject(new Error(`${program} exited (${status}): ${tail}`))
      );
    });
  } else throw new Error("Unsupported BAASX installation");
  return true;
}
