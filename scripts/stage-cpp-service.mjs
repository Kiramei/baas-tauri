import { copyFile, mkdir, realpath, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const serviceExecutableName = (platform = process.platform) =>
  platform === "win32" ? "BAAS_service.exe" : "BAAS_service";

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

export async function validateServiceExecutable(candidate, platform = process.platform) {
  if (!isAbsolute(candidate)) {
    throw new Error(`BAAS C++ service path must be absolute: ${candidate}`);
  }
  const canonical = await realpath(candidate);
  const metadata = await stat(canonical);
  if (!metadata.isFile()) throw new Error(`BAAS C++ service is not a file: ${canonical}`);
  if (!hasExactServiceBasename(canonical, platform)) {
    throw new Error(
      `BAAS C++ service must be named exactly ${serviceExecutableName(platform)}: ${canonical}`
    );
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

export async function stageCppService({
  source = process.env.BAAS_CPP_SERVICE_PATH,
  root = repositoryRoot,
} = {}) {
  const candidates = source ? [source] : defaultServiceCandidates(root);
  const failures = [];
  for (const candidate of candidates) {
    try {
      const canonical = await validateServiceExecutable(candidate);
      if (!source) {
        const canonicalOwner = await realpath(dirname(candidate));
        if (dirname(canonical) !== canonicalOwner) {
          throw new Error(
            `discovered service escapes its build output directory ${canonicalOwner}: ${canonical}`
          );
        }
      }
      const destination = join(root, "src-tauri", "resources", serviceExecutableName());
      await mkdir(dirname(destination), { recursive: true });
      await rm(destination, { force: true });
      await copyFile(canonical, destination);
      const verifiedDestination = await validateServiceExecutable(destination);
      if (dirname(verifiedDestination) !== (await realpath(dirname(destination)))) {
        throw new Error(
          `staged service escapes its Tauri resource directory: ${verifiedDestination}`
        );
      }
      return { source: canonical, destination: verifiedDestination };
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No verified BAAS C++ service executable was found.\n${failures.join("\n")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stageCppService()
    .then(({ source, destination }) => console.log(`Staged ${source} -> ${destination}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
