import { platformFor, platforms } from "../scripts/distribution-platforms.mjs";
import { describe, expect, test } from "bun:test";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const tar =
  process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
const manifest = JSON.parse(readFileSync(path.join(project, "package.json"), "utf8"));
const platformFixtures = platforms.map((p) => ({
  ...p,
  directory: p.os + "-" + p.cpu,
  binary: p.executable,
}));

function fixture(targets = platformFixtures) {
  const root = mkdtempSync(path.join(tmpdir(), "baasx-pack-test-"));
  const assets = path.join(root, "assets");
  const output = path.join(root, "output");
  const bundle = path.join(root, "baasx-node.mjs");
  mkdirSync(assets);
  writeFileSync(bundle, "console.log(JSON.stringify({ args: process.argv.slice(2) }));\n");
  for (const platform of targets) {
    const stage = path.join(root, platform.directory);
    mkdirSync(path.join(stage, "package", "runtime"), { recursive: true });
    writeFileSync(
      path.join(stage, "package", "runtime", platform.helper),
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"result"}));\n',
      { mode: 0o755 }
    );
    writeFileSync(
      path.join(stage, "package/runtime", platform.legacyHelper),
      '#!/bin/sh\nexec "${0%/*}/baasx-runtime" "$@"\n',
      { mode: 0o755 }
    );
    // A substantial stand-in for the standalone executable must not reach the npm tarball.
    writeFileSync(path.join(stage, "package", platform.binary), randomBytes(128 * 1024));
    if (platform.runtime === "node")
      writeFileSync(path.join(stage, "package/runtime/node"), randomBytes(128 * 1024));
    const archive = path.join(
      assets,
      `baasx-${manifest.version}-${platform.asset}${platform.packageExtension}`
    );
    execFileSync(tar, ["-czf", archive, "-C", stage, "package"]);
  }
  return { root, assets, output, bundle };
}

function pack({ assets, output, bundle }, options = [], env = process.env) {
  const result = spawnSync(
    "node",
    [
      path.join(project, "scripts", "registry-package.mjs"),
      "--assets",
      assets,
      "--bundle",
      bundle,
      "--output",
      output,
      "--scope",
      "kiramei",
      ...options,
    ],
    { encoding: "utf8", env }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

// The full installer fixture uses POSIX scripts as stand-ins for the executables.
const registryTest = process.platform === "win32" ? test.skip : test;

describe("registry package", () => {
  test("ARMv7l and armhf resolve to one hard-float npm package", () => {
    const arm = platformFor("linux", "arm");
    expect(arm).toMatchObject({
      name: "@kiramei/baasx-linux-arm",
      cpu: "arm",
      asset: "Linux-ARMV7L",
      rustTarget: "armv7-unknown-linux-gnueabihf",
      runtime: "node",
      packageExtension: "-node.tgz",
    });
    expect(platformFor("linux", "armv7l")).toBe(arm);
    expect(platformFor("linux", "armhf")).toBe(arm);
    for (const cpu of ["arm", "armv7l", "armhf"])
      expect(platformFor(`linux-${cpu}`)).toBe(arm);
    expect(platforms.filter((p) => p.os === "linux" && p.cpu === "arm")).toHaveLength(1);
    expect(platforms.some((p) => ["armv7l", "armhf"].includes(p.cpu))).toBe(false);
    expect(platformFor("linux", "armv6l")).toBeUndefined();
  });

  test("registry launcher resolves canonical ARM32 and both architecture aliases", () => {
    const root = mkdtempSync(path.join(tmpdir(), "baasx-arm-launcher-"));
    try {
      const bin = path.join(root, "bin");
      const dist = path.join(root, "dist");
      const platform = path.join(root, "node_modules/@kiramei/baasx-linux-arm");
      mkdirSync(bin);
      mkdirSync(dist);
      mkdirSync(path.join(platform, "runtime"), { recursive: true });
      copyFileSync(path.join(project, "registry/baasx.mjs"), path.join(bin, "baasx.mjs"));
      writeFileSync(
        path.join(platform, "package.json"),
        JSON.stringify({ exports: { "./helper": "./runtime/baasx-runtime" } })
      );
      const helper = path.join(platform, "runtime/baasx-runtime");
      writeFileSync(helper, "fixture");
      writeFileSync(
        path.join(dist, "baasx-node.mjs"),
        "console.log(JSON.stringify({helper:process.env.BAASX_RUNTIME_HELPER,args:process.argv.slice(2)}));\n"
      );
      const guard = path.join(root, "architecture.cjs");
      for (const cpu of ["arm", "armv7l", "armhf"]) {
        writeFileSync(
          guard,
          `Object.defineProperty(process,'platform',{value:'linux'});Object.defineProperty(process,'arch',{value:${JSON.stringify(cpu)}});`
        );
        const env = { ...process.env };
        delete env.BAASX_RUNTIME_HELPER;
        delete env.BAAS_RUNTIME_HELPER;
        const result = execFileSync(
          "node",
          ["--require", guard, path.join(bin, "baasx.mjs"), "--demo", "status"],
          { encoding: "utf8", env }
        );
        expect(JSON.parse(result)).toEqual({ helper, args: ["--demo", "status"] });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unpacked package launcher runs the Node bundle without Bun", () => {
    const root = mkdtempSync(path.join(tmpdir(), "baasx-node-launcher-"));
    try {
      mkdirSync(path.join(root, "bin"));
      mkdirSync(path.join(root, "dist"));
      const entry = path.join(root, "bin/baasx.mjs");
      copyFileSync(path.join(project, "bin/baasx.mjs"), entry);
      writeFileSync(path.join(root, "dist/baasx.js"), "throw new Error('Requires Bun');\n");
      writeFileSync(
        path.join(root, "dist/baasx-node.mjs"),
        "console.log(JSON.stringify({node:typeof Bun==='undefined',args:process.argv.slice(2)}));\n"
      );
      const result = execFileSync("node", [entry, "--demo", "status"], { encoding: "utf8" });
      expect(JSON.parse(result)).toEqual({ node: true, args: ["--demo", "status"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows bsdtar archive listings preserve both runtime names in npm packs", () => {
    const host = platformFixtures.find((p) => p.os === process.platform && p.cpu === process.arch);
    if (!host) throw new Error("Unsupported test host");
    const files = fixture([host]);
    try {
      const env = { ...process.env };
      if (process.platform !== "win32") {
        // Exercise CRLF on Unix too, while retaining real archive creation and extraction.
        const bin = path.join(files.root, "bin");
        mkdirSync(bin);
        writeFileSync(
          path.join(bin, "tar"),
          '#!/bin/sh\nif [ "$1" = "-tzf" ]; then\n  command -p tar "$@" | awk \'{printf "%s\\r\\n", $0}\'\nelse\n  command -p tar "$@"\nfi\n',
          { mode: 0o755 }
        );
        env.PATH = bin + path.delimiter + env.PATH;
      }
      const packages = pack(files, ["--host-only"], env);
      const archive = packages.find((p) => p.name === host.name).archive;
      for (const name of [host.helper, host.legacyHelper]) {
        const packed = execFileSync(tar, ["-xOzf", archive, "package/runtime/" + name]);
        expect(packed).toEqual(
          readFileSync(path.join(files.root, host.directory, "package/runtime", name))
        );
      }
    } finally {
      rmSync(files.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  registryTest(
    "packs exact platform dependencies and installs only the host helper",
    async () => {
      const files = fixture();
      try {
        const packages = pack(files);
        expect(packages.map((pkg) => pkg.name)).toEqual([
          ...platforms.map((p) => p.name),
          "@kiramei/baasx",
        ]);
        const cli = packages.find((p) => p.name === "@kiramei/baasx");
        const inspect = (p) =>
          JSON.parse(
            execFileSync("tar", ["-xOzf", p.archive, "package/package.json"], { encoding: "utf8" })
          );
        const entries = (p) =>
          execFileSync("tar", ["-tzf", p.archive], { encoding: "utf8" }).trim().split("\n");
        expect(packages.find((p) => p.name === "baasx")).toBeUndefined();
        expect(inspect(cli).optionalDependencies).toEqual(
          Object.fromEntries(platforms.map((p) => [p.name, manifest.version]))
        );
        expect(
          entries(cli).some((name) => name.includes("runtime/") || name.includes("platforms/"))
        ).toBe(false);
        for (const platform of platforms) {
          const helper = packages.find((p) => p.name === platform.name);
          expect(inspect(helper)).toMatchObject({
            os: [platform.os],
            cpu: [platform.cpu],
            version: manifest.version,
          });
          expect(entries(helper).sort()).toEqual(
            [
              "package/LICENSE",
              "package/package.json",
              "package/runtime/" + platform.helper,
              "package/runtime/" + platform.legacyHelper,
            ].sort()
          );
        }
        const file = path.join(files.root, "registry-info.json");
        writeFileSync(file, JSON.stringify(packages));
        const ancestorManifest = JSON.stringify({
          name: "unrelated-workspace",
          private: true,
          dependencies: { "never-fetch-outside-fixture": "1.0.0" },
        });
        writeFileSync(path.join(files.root, "package.json"), ancestorManifest);
        await promisify(execFile)(
          "node",
          [path.join(project, "scripts/registry-smoke.mjs"), file],
          {
            env: { ...process.env, TMPDIR: files.root, BAASX_SMOKE_BUN: process.execPath },
          }
        );
        expect(readFileSync(path.join(files.root, "package.json"), "utf8")).toBe(ancestorManifest);
        expect(existsSync(path.join(files.root, "bun.lock"))).toBe(false);
        // npm uses `arm` for both ARMv7l and Debian armhf, and must fetch exactly
        // one native helper even when package assembly runs on a different CPU.
        for (const target of ["linux-armv7l", "linux-armhf"]) {
          await promisify(execFile)("node", [
            path.join(project, "scripts/registry-smoke.mjs"),
            file,
            "--target",
            target,
            "--install-only",
          ]);
        }
      } finally {
        rmSync(files.root, { recursive: true, force: true });
      }
    },
    90_000
  );

  registryTest(
    "fails when a platform helper is missing",
    () => {
      const files = fixture();
      try {
        const platform = platformFixtures.find((p) => p.os === "win32" && p.cpu === "x64");
        const stage = path.join(files.root, platform.directory);
        rmSync(path.join(stage, "package", "runtime", platform.helper));
        const archive = path.join(
          files.assets,
          `baasx-${manifest.version}-${platform.asset}${platform.packageExtension}`
        );
        execFileSync("tar", ["-czf", archive, "-C", stage, "package"]);
        expect(() => pack(files)).toThrow("missing package/runtime/baasx-runtime.exe");
      } finally {
        rmSync(files.root, { recursive: true, force: true });
      }
    },
    30_000
  );
});
