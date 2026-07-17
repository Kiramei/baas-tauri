import { copyFile, mkdir, realpath, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const serviceExecutableName = (platform = process.platform) =>
  platform === "win32" ? "BAAS_service.exe" : "BAAS_service";

export const repositoryUpdaterExecutableName = (platform = process.platform) =>
  platform === "win32" ? "BAAS_runtime_repository_update.exe" : "BAAS_runtime_repository_update";

export const remoteJarName = "scrcpy-server.jar";

export const hasExactServiceBasename = (path, platform = process.platform) =>
  basename(path) === serviceExecutableName(platform);

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function defaultServiceCandidates(root = repositoryRoot, platform = process.platform) {
  const name = serviceExecutableName(platform);
  const cppRoots = [
    resolve(root, "..", "baas-cpp-dev"),
    resolve(root, "..", "..", "baas-cpp-dev"),
    resolve(root, "baas-cpp-dev"),
  ];
  const buildLayouts = [
    ["build", "service-app-main-release", "bin", name],
    ["build", "service-app-main-debug", "bin", name],
    ["build", "service-application", "bin", name],
    ["build", "service-application", "Release", name],
  ];
  return [
    ...new Set(cppRoots.flatMap((cppRoot) => buildLayouts.map((parts) => join(cppRoot, ...parts)))),
  ];
}

export function defaultRepositoryUpdaterCandidates(
  root = repositoryRoot,
  platform = process.platform
) {
  const name = repositoryUpdaterExecutableName(platform);
  const cppRoots = [
    resolve(root, "..", "baas-cpp-dev"),
    resolve(root, "..", "..", "baas-cpp-dev"),
    resolve(root, "baas-cpp-dev"),
  ];
  const buildLayouts = [
    ["build", "service-app-main-release", "bin", name],
    ["build", "tauri-service", "bin", name],
    ["build", "service-application", "bin", name],
    ["build", "service-application", "Release", name],
  ];
  return [
    ...new Set(cppRoots.flatMap((cppRoot) => buildLayouts.map((parts) => join(cppRoot, ...parts)))),
  ];
}

export async function inspectServiceExecutable(candidate, platform = process.platform) {
  if (!isAbsolute(candidate)) {
    throw new Error(`BAAS C++ service path must be absolute: ${candidate}`);
  }
  if (!hasExactServiceBasename(candidate, platform)) {
    throw new Error(
      `BAAS C++ service must be named exactly ${serviceExecutableName(platform)}: ${candidate}`
    );
  }
  const canonical = await realpath(candidate);
  const metadata = await stat(canonical);
  if (!metadata.isFile()) throw new Error(`BAAS C++ service is not a file: ${canonical}`);
  if (!hasExactServiceBasename(canonical, platform)) {
    throw new Error(
      `BAAS C++ service must be named exactly ${serviceExecutableName(platform)}: ${canonical}`
    );
  }
  return canonical;
}

export async function validateServiceExecutable(candidate, platform = process.platform, owner) {
  const canonical = await inspectServiceExecutable(candidate, platform);
  if (owner) {
    const canonicalOwner = await realpath(owner);
    if (dirname(canonical) !== canonicalOwner) {
      throw new Error(
        `BAAS C++ service escapes its owned directory ${canonicalOwner}: ${canonical}`
      );
    }
  }
  const probe = spawnSync(canonical, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  if (probe.error)
    throw new Error(`failed to execute ${canonical} --version: ${probe.error.message}`);
  if (
    probe.status !== 0 ||
    !/^BAAS_service \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\s*$/u.test(probe.stdout)
  ) {
    throw new Error(
      `unexpected BAAS C++ service identity from ${canonical}: status=${probe.status} stdout=${JSON.stringify(probe.stdout)}`
    );
  }
  return canonical;
}

export async function validateRepositoryUpdaterExecutable(
  candidate,
  platform = process.platform,
  owner
) {
  const expectedName = repositoryUpdaterExecutableName(platform);
  if (!isAbsolute(candidate)) {
    throw new Error(`BAAS runtime repository updater path must be absolute: ${candidate}`);
  }
  if (basename(candidate) !== expectedName) {
    throw new Error(
      `BAAS runtime repository updater must be named exactly ${expectedName}: ${candidate}`
    );
  }
  const metadata = await stat(candidate);
  if (!metadata.isFile()) {
    throw new Error(`BAAS runtime repository updater is not a file: ${candidate}`);
  }
  const canonical = await realpath(candidate);
  if (basename(canonical) !== expectedName) {
    throw new Error(`BAAS runtime repository updater resolves to the wrong filename: ${canonical}`);
  }
  if (owner) {
    const canonicalOwner = await realpath(owner);
    if (dirname(canonical) !== canonicalOwner) {
      throw new Error(
        `BAAS runtime repository updater escapes its owned directory ${canonicalOwner}: ${canonical}`
      );
    }
  }
  const probe = spawnSync(canonical, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  if (probe.error) {
    throw new Error(`failed to execute ${canonical} --version: ${probe.error.message}`);
  }
  if (
    probe.status !== 0 ||
    !/^BAAS_runtime_repository_update \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\s*$/u.test(probe.stdout)
  ) {
    throw new Error(
      `unexpected BAAS runtime repository updater identity from ${canonical}: status=${probe.status} stdout=${JSON.stringify(probe.stdout)}`
    );
  }
  return canonical;
}

export async function stageCppService({
  source = process.env.BAAS_CPP_SERVICE_PATH,
  root = repositoryRoot,
} = {}) {
  const candidates = source ? [source] : defaultServiceCandidates(root);
  const failures = [];
  for (const candidate of candidates) {
    try {
      const canonical = await validateServiceExecutable(
        candidate,
        process.platform,
        source ? undefined : dirname(candidate)
      );
      const destination = join(root, "src-tauri", "resources", serviceExecutableName());
      await mkdir(dirname(destination), { recursive: true });
      await rm(destination, { force: true });
      await copyFile(canonical, destination);
      const verifiedDestination = await validateServiceExecutable(
        destination,
        process.platform,
        dirname(destination)
      );
      return { source: canonical, destination: verifiedDestination };
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No verified BAAS C++ service executable was found.\n${failures.join("\n")}`);
}

export async function stageRuntimeRepositoryUpdater({
  source = process.env.BAAS_CPP_RUNTIME_REPOSITORY_UPDATER_PATH,
  root = repositoryRoot,
} = {}) {
  const candidates = source ? [source] : defaultRepositoryUpdaterCandidates(root);
  const failures = [];
  for (const candidate of candidates) {
    try {
      const canonical = await validateRepositoryUpdaterExecutable(
        candidate,
        process.platform,
        source ? undefined : dirname(candidate)
      );
      const destination = join(root, "src-tauri", "resources", repositoryUpdaterExecutableName());
      await mkdir(dirname(destination), { recursive: true });
      await rm(destination, { force: true });
      await copyFile(canonical, destination);
      const verifiedDestination = await validateRepositoryUpdaterExecutable(
        destination,
        process.platform,
        dirname(destination)
      );
      return { source: canonical, destination: verifiedDestination };
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `No verified BAAS runtime repository updater executable was found.\n${failures.join("\n")}`
  );
}

export async function stageCppRemoteJar({
  source = process.env.BAAS_CPP_SERVICE_REMOTE_JAR,
  root = repositoryRoot,
} = {}) {
  if (!source) throw new Error("BAAS_CPP_SERVICE_REMOTE_JAR is required for C++ packaging");
  if (!isAbsolute(source)) {
    throw new Error(`BAAS C++ remote jar path must be absolute: ${source}`);
  }
  if (basename(source) !== remoteJarName) {
    throw new Error(`BAAS C++ remote jar must be named exactly ${remoteJarName}: ${source}`);
  }
  const canonical = await realpath(source);
  const metadata = await stat(canonical);
  if (!metadata.isFile()) throw new Error(`BAAS C++ remote jar is not a file: ${canonical}`);
  if (basename(canonical) !== remoteJarName) {
    throw new Error(`BAAS C++ remote jar resolves to the wrong filename: ${canonical}`);
  }

  const owner = join(root, "src-tauri", "resources");
  const destination = join(owner, "ws-scrcpy-server.jar");
  await mkdir(owner, { recursive: true });
  await rm(destination, { force: true });
  await copyFile(canonical, destination);
  const verified = await realpath(destination);
  const verifiedOwner = await realpath(owner);
  const copied = await stat(verified);
  if (!copied.isFile() || dirname(verified) !== verifiedOwner) {
    throw new Error(`Staged C++ remote jar escapes its owned directory: ${verified}`);
  }
  if (copied.size !== metadata.size || copied.size === 0) {
    throw new Error(`Staged C++ remote jar size mismatch: ${verified}`);
  }
  return { source: canonical, destination: verified };
}

export async function stageCppServiceResources({
  service = {},
  repositoryUpdater = {},
  remoteJar = {},
} = {}) {
  const executable = await stageCppService(service);
  const updater = await stageRuntimeRepositoryUpdater(repositoryUpdater);
  const jar = await stageCppRemoteJar(remoteJar);
  return { executable, repositoryUpdater: updater, remoteJar: jar };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stageCppServiceResources()
    .then(({ executable, repositoryUpdater, remoteJar }) => {
      console.log(`Staged ${executable.source} -> ${executable.destination}`);
      console.log(`Staged ${repositoryUpdater.source} -> ${repositoryUpdater.destination}`);
      console.log(`Staged ${remoteJar.source} -> ${remoteJar.destination}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
