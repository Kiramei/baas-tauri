import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  defaultServiceCandidates,
  hasExactServiceBasename,
  serviceExecutableName,
  validateServiceExecutable,
} from "../../scripts/stage-cpp-service.mjs";
import { shouldPackageCppService } from "../../scripts/portable-fixed-webview2.mjs";
import {
  prepareCppServiceProjectRoot,
  smokeCppService,
} from "../../scripts/smoke-cpp-service.mjs";

describe("C++ service packaging contract", () => {
  test("uses the exact platform-native service filename", () => {
    expect(serviceExecutableName("win32")).toBe("BAAS_service.exe");
    expect(serviceExecutableName("linux")).toBe("BAAS_service");
    expect(serviceExecutableName("darwin")).toBe("BAAS_service");
    expect(hasExactServiceBasename("D:/bin/BAAS_service.exe", "win32")).toBe(true);
    expect(hasExactServiceBasename("D:/bin/evilBAAS_service.exe", "win32")).toBe(false);
  });

  test("development candidates are absolute, ordered, and never PATH entries", () => {
    const candidates = defaultServiceCandidates(resolve("D:/workspace/baas-tauri"), "win32");
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.includes("baas-cpp-dev"))).toBe(true);
    expect(candidates.every((candidate) => candidate.endsWith("BAAS_service.exe"))).toBe(true);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  test("portable packaging never reuses an x64 service for ARM", () => {
    expect(shouldPackageCppService("x86_64-pc-windows-msvc", "x64")).toBe(true);
    expect(shouldPackageCppService("aarch64-pc-windows-msvc", "arm64")).toBe(false);
    expect(shouldPackageCppService("aarch64-pc-windows-msvc", "x64")).toBe(false);
  });

  test("real lifecycle smoke cannot silently skip a missing binary", async () => {
    await expect(smokeCppService("")).rejects.toThrow("BAAS_CPP_SERVICE_PATH is required");
  });

  test("real lifecycle fixture owns every required project-root resource", async () => {
    const root = await mkdtemp(join(tmpdir(), "baas-cpp-service-project-test-"));
    const fixture = join(root, "fixture", "scrcpy-server.jar");
    const projectRoot = join(root, "project");
    await mkdir(dirname(fixture), { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(fixture, "pinned-remote-jar");
    try {
      await prepareCppServiceProjectRoot(projectRoot, fixture);
      expect(await readFile(join(projectRoot, "service", "remote", "scrcpy-server.jar"), "utf8"))
        .toBe("pinned-remote-jar");
      expect(await readFile(join(projectRoot, "config", "source", "config.json"), "utf8"))
        .toContain('"name":"Smoke"');
      expect(await readFile(join(projectRoot, "config", "static.json"), "utf8"))
        .toContain('"source":"tauri-smoke"');
      expect(await readFile(join(projectRoot, "setup.toml"), "utf8"))
        .toContain("channel = 'stable'");
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

  test.skipIf(!process.env.BAAS_CPP_SERVICE_PATH)(
    "accepts a real discoverable service identity",
    async () => {
      expect(await validateServiceExecutable(process.env.BAAS_CPP_SERVICE_PATH!)).toBeString();
    }
  );
});
