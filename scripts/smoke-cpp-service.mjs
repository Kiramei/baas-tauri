import { copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { validateServiceExecutable } from "./stage-cpp-service.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const CURRENT_SCHEMA = "baas.runtime-repositories.current/v1";
const SNAPSHOT_SCHEMA = "baas.runtime-repositories.snapshot/v1";
const TREE_MANIFEST_SCHEMA = "baas.runtime-repository.tree-manifest/v1";

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function updateLengthPrefixed(hash, value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

export function runtimeRepositoryGeneration(repositories) {
  const hash = createHash("sha256");
  updateLengthPrefixed(hash, SNAPSHOT_SCHEMA);
  for (const repository of repositories) {
    for (const field of ["id", "commit", "root", "manifest", "manifest_sha256"]) {
      updateLengthPrefixed(hash, repository[field]);
    }
  }
  return hash.digest("hex");
}

async function publishEmptyRuntimeRepository(projectRoot) {
  const repositoryRoot = join(projectRoot, ".baas-updater", "runtime-repositories");
  const manifestBytes = Buffer.from(
    JSON.stringify({ schema: TREE_MANIFEST_SCHEMA, entries: [] }),
    "utf8"
  );
  const manifestSha256 = sha256Hex(manifestBytes);
  const repositories = [
    { id: "resources", commit: "1".repeat(40), manifest: "resources.json" },
    { id: "scripts", commit: "2".repeat(40), manifest: "scripts.json" },
  ].map(({ id, commit, manifest }) => ({
    id,
    commit,
    root: `objects/${id}/${commit}`,
    manifest,
    manifest_sha256: manifestSha256,
  }));
  const generation = runtimeRepositoryGeneration(repositories);
  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    generation,
    repositories,
  };
  const current = {
    schema: CURRENT_SCHEMA,
    generation,
    snapshot: `snapshots/${generation}.json`,
  };

  await Promise.all([
    mkdir(join(repositoryRoot, "staging"), { recursive: true }),
    mkdir(join(repositoryRoot, "snapshots"), { recursive: true }),
    ...repositories.map((repository) =>
      mkdir(join(repositoryRoot, ...repository.root.split("/")), { recursive: true })
    ),
  ]);
  await Promise.all([
    ...repositories.map((repository) =>
      writeFile(
        join(repositoryRoot, ...repository.root.split("/"), repository.manifest),
        manifestBytes
      )
    ),
    writeFile(join(repositoryRoot, "snapshots", `${generation}.json`), JSON.stringify(snapshot)),
  ]);
  await writeFile(join(repositoryRoot, "current.json"), JSON.stringify(current));
  return generation;
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  if (!port) throw new Error("failed to reserve a loopback port");
  return port;
}

async function strictJson(port, path, method = "GET") {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    signal: AbortSignal.timeout(1_000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 64 * 1024) throw new Error(`${path} response exceeds 64 KiB`);
  return { status: response.status, value: JSON.parse(new TextDecoder().decode(bytes)) };
}

export async function prepareCppServiceProjectRoot(
  projectRoot,
  remoteJar = process.env.BAAS_CPP_SERVICE_REMOTE_JAR
) {
  if (!remoteJar) {
    throw new Error("BAAS_CPP_SERVICE_REMOTE_JAR is required for real service smoke");
  }
  if (!isAbsolute(remoteJar)) {
    throw new Error(`BAAS C++ remote jar path must be absolute: ${remoteJar}`);
  }
  if (basename(remoteJar) !== "scrcpy-server.jar") {
    throw new Error(`BAAS C++ remote jar must be named exactly scrcpy-server.jar: ${remoteJar}`);
  }
  const canonicalJar = await realpath(remoteJar);
  const metadata = await stat(canonicalJar);
  if (!metadata.isFile()) throw new Error(`BAAS C++ remote jar is not a file: ${canonicalJar}`);

  const source = join(projectRoot, "config", "source");
  const remote = join(projectRoot, "service", "remote");
  await mkdir(source, { recursive: true });
  await mkdir(remote, { recursive: true });
  await Promise.all([
    writeFile(join(source, "config.json"), '{"name":"Smoke","server":"JP"}'),
    writeFile(join(source, "event.json"), "[]"),
    writeFile(join(projectRoot, "config", "static.json"), '{"version":1,"source":"tauri-smoke"}'),
    writeFile(join(projectRoot, "setup.toml"), "[general]\nchannel = 'stable'\n"),
    copyFile(canonicalJar, join(remote, "scrcpy-server.jar")),
  ]);
  const runtimeRepositoryGeneration = await publishEmptyRuntimeRepository(projectRoot);
  return { remoteJar: canonicalJar, runtimeRepositoryGeneration };
}

export async function smokeCppService(
  executable = process.env.BAAS_CPP_SERVICE_PATH,
  remoteJar = process.env.BAAS_CPP_SERVICE_REMOTE_JAR
) {
  if (!executable) throw new Error("BAAS_CPP_SERVICE_PATH is required for real service smoke");
  const canonical = await validateServiceExecutable(executable);
  const projectRoot = await mkdtemp(join(tmpdir(), "baas-cpp-service-smoke-"));
  try {
    const { runtimeRepositoryGeneration } = await prepareCppServiceProjectRoot(
      projectRoot,
      remoteJar
    );
    const port = await availablePort();
    const child = spawn(
      canonical,
      [
        "--project-root",
        projectRoot,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--runtime-repository-generation",
        runtimeRepositoryGeneration,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    return await observeCppServiceLifecycle(
      child,
      canonical,
      projectRoot,
      port,
      runtimeRepositoryGeneration
    );
  } catch (error) {
    await rm(projectRoot, { recursive: true, force: true });
    throw error;
  }
}

async function observeCppServiceLifecycle(
  child,
  canonical,
  projectRoot,
  port,
  runtimeRepositoryGeneration
) {
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  let exited = false;
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    })
  );
  try {
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline && !exited) {
      try {
        const version = await strictJson(port, "/version");
        const health = await strictJson(port, "/health");
        if (
          version.status === 200 &&
          version.value?.ok === true &&
          version.value?.api_version === 1 &&
          version.value?.service === "BAAS Service" &&
          typeof version.value?.version === "string" &&
          /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version.value.version) &&
          health.status === 200 &&
          health.value?.ok === true &&
          health.value?.statuses?.runtime?.phase === "ready" &&
          health.value?.statuses?.runtime?.repository?.phase === "pinned" &&
          health.value?.statuses?.runtime?.repository?.generation === runtimeRepositoryGeneration
        ) {
          ready = true;
          break;
        }
      } catch {
        // Connection failures are expected only while startup is racing.
      }
      await delay(100);
    }
    if (!ready) throw new Error("real BAAS_service did not publish strict ready identity");
    const shutdown = await strictJson(port, "/shutdown", "POST");
    if (
      shutdown.status !== 202 ||
      shutdown.value?.ok !== true ||
      shutdown.value?.api_version !== 1 ||
      shutdown.value?.accepted !== true
    ) {
      throw new Error(`unexpected shutdown response: ${JSON.stringify(shutdown)}`);
    }
    const result = await Promise.race([
      exit,
      delay(5_000).then(() => {
        throw new Error("real BAAS_service did not exit after shutdown");
      }),
    ]);
    if (result.code !== 0 || result.signal) {
      throw new Error(`real BAAS_service exited abnormally: ${JSON.stringify(result)}`);
    }
    return { executable: canonical, port, runtimeRepositoryGeneration };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : error}\n${Buffer.concat(output).toString("utf8")}`
    );
  } finally {
    if (!exited) {
      child.kill("SIGKILL");
      await Promise.race([exit, delay(2_000)]);
    }
    await rm(projectRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  smokeCppService()
    .then(({ executable, port }) =>
      console.log(`Real C++ service smoke passed: ${executable} port=${port}`)
    )
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
