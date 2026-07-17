import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  defaultServiceCandidates,
  defaultRepositoryUpdaterCandidates,
  hasExactServiceBasename,
  remoteJarName,
  repositoryUpdaterExecutableName,
  serviceExecutableName,
  stageCppRemoteJar,
  stageCppServiceResources,
  stageRuntimeRepositoryUpdater,
  validateRepositoryUpdaterExecutable,
  validateServiceExecutable,
} from "../../scripts/stage-cpp-service.mjs";
import {
  cppPortableResourceNames,
  shouldPackageCppService,
  validatePortableRemoteJar,
} from "../../scripts/portable-fixed-webview2.mjs";
import { prepareCppServiceProjectRoot, smokeCppService } from "../../scripts/smoke-cpp-service.mjs";

describe("C++ service packaging contract", () => {
  test("requires an explicit pushed C++ integration pin and product trust key", async () => {
    const action = await readFile(resolve(".github/actions/build-cpp-service/action.yml"), "utf8");
    expect(action).toContain("source-ref:");
    expect(action).toContain("runtime-repository-trusted-public-key-hex:");
    expect(action).toContain("ref: ${{ inputs.source-ref }}");
    expect(action).toContain("^[0-9a-f]{40}$");
    expect(action).toContain("^[0-9a-f]{64}$");
    expect(action).toContain("-DBUILD_SERVICE_RUNTIME_REPOSITORY_UPDATE_APP=ON");
    expect(action).toContain("--target BAAS_service BAAS_runtime_repository_update");
    const httplibCreate = action
      .split(/\r?\n/u)
      .find((line) => line.includes("conan create deploy/conan/recipes/baas-cpp-httplib"));
    const libgit2Create = action
      .split(/\r?\n/u)
      .find((line) => line.includes("conan create deploy/conan/recipes/baas-libgit2"));
    expect(httplibCreate).toBeDefined();
    expect(httplibCreate).not.toContain("--no-remote");
    expect(libgit2Create).toContain("--no-remote");
    expect(action).not.toContain("ref: 71137daf09469df2c1ef45f48425b29471a848a7");
    for (const workflowPath of [
      ".github/workflows/code-quality.yml",
      ".github/workflows/release-app.yml",
    ]) {
      const workflow = await readFile(resolve(workflowPath), "utf8");
      const uses = workflow.match(/uses: \.\/\.github\/actions\/build-cpp-service/gu) ?? [];
      const refs =
        workflow.match(/source-ref: \$\{\{ vars\.BAAS_CPP_DEV_RUNTIME_REPOSITORY_REF \}\}/gu) ?? [];
      const keys =
        workflow.match(
          /runtime-repository-trusted-public-key-hex: \$\{\{ vars\.BAAS_RUNTIME_REPOSITORY_TRUSTED_PUBLIC_KEY_HEX \}\}/gu
        ) ?? [];
      expect(refs).toHaveLength(uses.length);
      expect(keys).toHaveLength(uses.length);
    }
    const codeQuality = await readFile(resolve(".github/workflows/code-quality.yml"), "utf8");
    expect(codeQuality).toContain(
      "if: ${{ vars.BAAS_CPP_DEV_RUNTIME_REPOSITORY_REF != '' && vars.BAAS_RUNTIME_REPOSITORY_TRUSTED_PUBLIC_KEY_HEX != '' }}"
    );
    const release = await readFile(resolve(".github/workflows/release-app.yml"), "utf8");
    expect(release).not.toContain("BAAS_CPP_DEV_RUNTIME_REPOSITORY_REF != ''");
  });

  test("uses the exact platform-native service filename", () => {
    expect(serviceExecutableName("win32")).toBe("BAAS_service.exe");
    expect(serviceExecutableName("linux")).toBe("BAAS_service");
    expect(serviceExecutableName("darwin")).toBe("BAAS_service");
    expect(hasExactServiceBasename("D:/bin/BAAS_service.exe", "win32")).toBe(true);
    expect(hasExactServiceBasename("D:/bin/evilBAAS_service.exe", "win32")).toBe(false);
  });

  test("uses the exact platform-native repository updater filename", () => {
    expect(repositoryUpdaterExecutableName("win32")).toBe("BAAS_runtime_repository_update.exe");
    expect(repositoryUpdaterExecutableName("linux")).toBe("BAAS_runtime_repository_update");
    expect(repositoryUpdaterExecutableName("darwin")).toBe("BAAS_runtime_repository_update");
  });

  test("desktop package manifests contain service, updater, and unchanged ws-scrcpy resource", async () => {
    const windows = JSON.parse(
      await readFile(resolve("src-tauri/tauri.cpp-service.windows.conf.json"), "utf8")
    );
    const unix = JSON.parse(
      await readFile(resolve("src-tauri/tauri.cpp-service.unix.conf.json"), "utf8")
    );
    expect(windows.bundle.resources).toEqual({
      "resources/BAAS_service.exe": "BAAS_service.exe",
      "resources/BAAS_runtime_repository_update.exe": "BAAS_runtime_repository_update.exe",
      "resources/ws-scrcpy-server.jar": "ws-scrcpy-server.jar",
    });
    expect(unix.bundle.resources).toEqual({
      "resources/BAAS_service": "BAAS_service",
      "resources/BAAS_runtime_repository_update": "BAAS_runtime_repository_update",
      "resources/ws-scrcpy-server.jar": "ws-scrcpy-server.jar",
    });
  });

  test("development candidates are absolute, ordered, and never PATH entries", () => {
    const candidates = defaultServiceCandidates(resolve("D:/workspace/baas-tauri"), "win32");
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.includes("baas-cpp-dev"))).toBe(true);
    expect(candidates.every((candidate) => candidate.endsWith("BAAS_service.exe"))).toBe(true);
    expect(new Set(candidates).size).toBe(candidates.length);
    const updaterCandidates = defaultRepositoryUpdaterCandidates(
      resolve("D:/workspace/baas-tauri"),
      "win32"
    );
    expect(updaterCandidates.length).toBeGreaterThan(0);
    expect(updaterCandidates.every((candidate) => candidate.includes("baas-cpp-dev"))).toBe(true);
    expect(
      updaterCandidates.every((candidate) =>
        candidate.endsWith("BAAS_runtime_repository_update.exe")
      )
    ).toBe(true);
    expect(new Set(updaterCandidates).size).toBe(updaterCandidates.length);
  });

  test("portable packaging never reuses an x64 service for ARM", () => {
    expect(shouldPackageCppService("x86_64-pc-windows-msvc", "x64")).toBe(true);
    expect(shouldPackageCppService("aarch64-pc-windows-msvc", "arm64")).toBe(false);
    expect(shouldPackageCppService("aarch64-pc-windows-msvc", "x64")).toBe(false);
    expect(cppPortableResourceNames).toEqual([
      "BAAS_service.exe",
      "BAAS_runtime_repository_update.exe",
      "ws-scrcpy-server.jar",
    ]);
  });

  test("portable packaging verifies the exact staged remote jar", async () => {
    const root = await mkdtemp(join(tmpdir(), "baas-cpp-portable-remote-"));
    const source = join(root, "source", "scrcpy-server.jar");
    const staged = join(root, "resources", "ws-scrcpy-server.jar");
    await mkdir(dirname(source), { recursive: true });
    await mkdir(dirname(staged), { recursive: true });
    await writeFile(source, "pinned-portable-jar");
    await writeFile(staged, "pinned-portable-jar");
    try {
      expect(await validatePortableRemoteJar(source, staged)).toBe(await realpath(staged));
      await writeFile(staged, "wrong");
      await expect(validatePortableRemoteJar(source, staged)).rejects.toThrow("does not match");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("real lifecycle smoke cannot silently skip a missing binary", async () => {
    await expect(smokeCppService("")).rejects.toThrow("BAAS_CPP_SERVICE_PATH is required");
  });

  test("C++ packaging requires and owns the exact ws-scrcpy jar", async () => {
    const root = await mkdtemp(join(tmpdir(), "baas-cpp-remote-stage-"));
    const sourceRoot = join(root, "source");
    const projectRoot = join(root, "tauri");
    const source = join(sourceRoot, remoteJarName);
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(source, "pinned-ws-scrcpy");
    try {
      const staged = await stageCppRemoteJar({ source, root: projectRoot });
      expect(staged.source).toBe(await realpath(source));
      expect(staged.destination).toBe(
        await realpath(join(projectRoot, "src-tauri", "resources", "ws-scrcpy-server.jar"))
      );
      expect(await readFile(staged.destination, "utf8")).toBe("pinned-ws-scrcpy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("C++ packaging rejects a missing or renamed remote jar", async () => {
    await expect(stageCppRemoteJar({ source: "" })).rejects.toThrow(
      "BAAS_CPP_SERVICE_REMOTE_JAR is required"
    );
    await expect(
      stageCppRemoteJar({ source: resolve("D:/fixture/not-scrcpy.jar") })
    ).rejects.toThrow("named exactly scrcpy-server.jar");
  });

  test("real lifecycle fixture owns every required project-root resource", async () => {
    const root = await mkdtemp(join(tmpdir(), "baas-cpp-service-project-test-"));
    const fixture = join(root, "fixture", "scrcpy-server.jar");
    const projectRoot = join(root, "project");
    await mkdir(dirname(fixture), { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(fixture, "pinned-remote-jar");
    try {
      const prepared = await prepareCppServiceProjectRoot(projectRoot, fixture);
      expect(
        await readFile(join(projectRoot, "service", "remote", "scrcpy-server.jar"), "utf8")
      ).toBe("pinned-remote-jar");
      expect(
        await readFile(join(projectRoot, "config", "source", "config.json"), "utf8")
      ).toContain('"name":"Smoke"');
      expect(await readFile(join(projectRoot, "config", "static.json"), "utf8")).toContain(
        '"source":"tauri-smoke"'
      );
      expect(await readFile(join(projectRoot, "setup.toml"), "utf8")).toContain(
        "channel = 'stable'"
      );
      expect(prepared.runtimeRepositoryGeneration).toMatch(/^[0-9a-f]{64}$/u);
      const repositoryRoot = join(projectRoot, ".baas-updater", "runtime-repositories");
      const current = JSON.parse(await readFile(join(repositoryRoot, "current.json"), "utf8"));
      const snapshot = JSON.parse(
        await readFile(join(repositoryRoot, ...current.snapshot.split("/")), "utf8")
      );
      expect(current.generation).toBe(prepared.runtimeRepositoryGeneration);
      expect(snapshot.generation).toBe(prepared.runtimeRepositoryGeneration);
      expect(snapshot.repositories.map((repository) => repository.id)).toEqual([
        "resources",
        "scripts",
      ]);
      for (const repository of snapshot.repositories) {
        const manifestBytes = await readFile(
          join(repositoryRoot, ...repository.root.split("/"), repository.manifest)
        );
        const manifest = JSON.parse(manifestBytes.toString("utf8"));
        expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(
          repository.manifest_sha256
        );
        expect(manifest.schema).toBe("baas.runtime-repository.tree-manifest/v1");
        if (repository.id === "scripts") {
          expect(manifest.entries).toEqual([]);
        } else {
          expect(manifest.entries.map((entry) => entry.path)).toEqual([
            "service/configuration/defaults/event.json",
            "service/configuration/defaults/static.json",
            "service/configuration/defaults/switch.json",
            "service/configuration/defaults/user.json",
          ]);
          for (const entry of manifest.entries) {
            const bytes = await readFile(
              join(repositoryRoot, ...repository.root.split("/"), ...entry.path.split("/"))
            );
            expect(String(bytes.byteLength)).toBe(entry.size);
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
          }
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects relative overrides before process execution", async () => {
    await expect(validateServiceExecutable("BAAS_service.exe", "win32")).rejects.toThrow(
      "must be absolute"
    );
  });

  test("rejects a deceptive original basename before filesystem lookup", async () => {
    await expect(
      validateServiceExecutable(resolve("D:/bin/evilBAAS_service.exe"), "win32")
    ).rejects.toThrow("named exactly BAAS_service.exe");
  });

  test("rejects an owned symlink or reparse escape before first spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "baas-service-owner-test-"));
    const owner = join(root, "owner");
    const outside = join(root, "outside");
    const name = serviceExecutableName();
    const target = join(outside, name);
    const alias = join(owner, name);
    await mkdir(dirname(alias), { recursive: true });
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "not executable and must never be spawned");
    try {
      await symlink(target, alias, "file");
    } catch {
      await rm(root, { recursive: true, force: true });
      return;
    }
    try {
      await expect(validateServiceExecutable(alias, process.platform, owner)).rejects.toThrow(
        "escapes its owned directory"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a renamed or owned updater symlink before first spawn", async () => {
    await expect(
      validateRepositoryUpdaterExecutable(resolve("D:/bin/not-the-updater.exe"), "win32")
    ).rejects.toThrow("named exactly BAAS_runtime_repository_update.exe");

    const root = await mkdtemp(join(tmpdir(), "baas-updater-owner-test-"));
    const owner = join(root, "owner");
    const outside = join(root, "outside");
    const name = repositoryUpdaterExecutableName();
    const target = join(outside, name);
    const alias = join(owner, name);
    await mkdir(owner, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(target, "must not execute");
    try {
      await symlink(target, alias, "file");
    } catch {
      await rm(root, { recursive: true, force: true });
      return;
    }
    try {
      await expect(
        validateRepositoryUpdaterExecutable(alias, process.platform, owner)
      ).rejects.toThrow("escapes its owned directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stages and revalidates a fake packaged repository updater", async () => {
    const root = await mkdtemp(join(tmpdir(), "baas-updater-stage-test-"));
    const sourceRoot = join(root, "source");
    const projectRoot = join(root, "tauri");
    const rustSource = join(sourceRoot, "fake.rs");
    const executable = join(sourceRoot, repositoryUpdaterExecutableName());
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      rustSource,
      `fn main() {
  if std::env::args().nth(1).as_deref() == Some("--version") {
    println!("BAAS_runtime_repository_update 1.2.3");
  } else {
    std::process::exit(2);
  }
}
`
    );
    const compiled = spawnSync("rustc", [rustSource, "-o", executable], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    expect(compiled.status).toBe(0);
    try {
      const staged = await stageRuntimeRepositoryUpdater({
        source: executable,
        root: projectRoot,
      });
      expect(staged.source).toBe(await realpath(executable));
      expect(staged.destination).toBe(
        await realpath(
          join(projectRoot, "src-tauri", "resources", repositoryUpdaterExecutableName())
        )
      );
      expect(
        await validateRepositoryUpdaterExecutable(
          staged.destination,
          process.platform,
          dirname(staged.destination)
        )
      ).toBe(staged.destination);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(
    !process.env.BAAS_CPP_SERVICE_PATH ||
      !process.env.BAAS_CPP_RUNTIME_REPOSITORY_UPDATER_PATH ||
      !process.env.BAAS_CPP_SERVICE_REMOTE_JAR
  )(
    "combined staging owns both native programs and its remote jar",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "baas-cpp-combined-stage-"));
      try {
        const staged = await stageCppServiceResources({
          service: { source: process.env.BAAS_CPP_SERVICE_PATH, root },
          repositoryUpdater: {
            source: process.env.BAAS_CPP_RUNTIME_REPOSITORY_UPDATER_PATH,
            root,
          },
          remoteJar: { source: process.env.BAAS_CPP_SERVICE_REMOTE_JAR, root },
        });
        expect(staged.executable.destination).toBe(
          await realpath(join(root, "src-tauri", "resources", serviceExecutableName()))
        );
        expect(staged.remoteJar.destination).toBe(
          await realpath(join(root, "src-tauri", "resources", "ws-scrcpy-server.jar"))
        );
        expect(staged.repositoryUpdater.destination).toBe(
          await realpath(join(root, "src-tauri", "resources", repositoryUpdaterExecutableName()))
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000
  );
});
