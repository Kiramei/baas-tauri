import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(project, "package.json"), "utf8"));
const platformFixtures = [
  { asset: "Linux-X64", directory: "linux-x64", helper: "baas-cli-runtime", binary: "baasx" },
  { asset: "macOS-ARM64", directory: "darwin-arm64", helper: "baas-cli-runtime", binary: "baasx" },
  { asset: "Windows-X64", directory: "win32-x64", helper: "baas-cli-runtime.exe", binary: "baasx.exe" },
];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "baasx-pack-test-"));
  const assets = path.join(root, "assets");
  const output = path.join(root, "output");
  const bundle = path.join(root, "baasx-node.mjs");
  mkdirSync(assets);
  writeFileSync(bundle, 'console.log(JSON.stringify({ args: process.argv.slice(2) }));\n');
  for (const platform of platformFixtures) {
    const stage = path.join(root, platform.directory);
    mkdirSync(path.join(stage, "package", "runtime"), { recursive: true });
    writeFileSync(path.join(stage, "package", "runtime", platform.helper), `helper: ${platform.directory}`);
    // A substantial stand-in for the standalone executable must not reach the npm tarball.
    writeFileSync(path.join(stage, "package", platform.binary), randomBytes(128 * 1024));
    const archive = path.join(assets, `baasx-${manifest.version}-${platform.asset}-bun.tgz`);
    execFileSync("tar", ["-czf", archive, "-C", stage, "package"]);
  }
  return { root, assets, output, bundle };
}

function pack({ assets, output, bundle }) {
  const result = spawnSync(
    "node",
    [path.join(project, "scripts", "registry-package.mjs"), "--assets", assets, "--bundle", bundle, "--output", output, "--scope", "kiramei"],
    { encoding: "utf8" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

// Registry packages are assembled on Linux. Node cannot directly spawn npm.cmd
// on Windows; the other platform checks exercise the standalone distributions.
const registryTest = process.platform === "win32" ? test.skip : test;

describe("registry package", () => {
  registryTest("includes the JS entry and native helpers, not the standalone executables", () => {
    const files = fixture();
    try {
      const info = pack(files);
      expect(info.name).toBe("@kiramei/baasx");
      expect(info.version).toBe(manifest.version);
      expect(info.integrity).toStartWith("sha512-");
      const entries = execFileSync("tar", ["-tzf", info.archive], { encoding: "utf8" }).split("\n");
      expect(entries).toContain("package/bin/baasx.mjs");
      expect(entries).toContain("package/dist/baasx-node.mjs");
      for (const platform of platformFixtures) {
        expect(entries).toContain(`package/platforms/${platform.directory}/runtime/${platform.helper}`);
        expect(entries).not.toContain(`package/platforms/${platform.directory}/${platform.binary}`);
      }
      expect(entries.filter((entry) => /\/baasx(?:\.exe)?$/.test(entry))).toEqual([]);
      // Random binary stand-ins do not compress; this catches unintended inclusion
      // without setting a brittle size threshold on the actual release archive.
      expect(statSync(info.archive).size).toBeLessThan(64 * 1024);

      const prefix = path.join(files.root, "install");
      execFileSync("npm", ["install", "--global", "--prefix", prefix, info.archive, "--ignore-scripts", "--no-audit", "--no-fund", "--offline"], {
        env: { ...process.env, npm_config_cache: path.join(files.root, "npm-cache") },
        stdio: "pipe",
      });
      const installed = path.join(prefix, "lib", "node_modules", "@kiramei", "baasx");
      expect(existsSync(path.join(installed, "platforms", "darwin-arm64", "runtime", "baas-cli-runtime"))).toBe(true);
      const stdout = execFileSync("node", [path.join(installed, "bin", "baasx.mjs"), "--demo", "--json", "status"], { encoding: "utf8" });
      expect(JSON.parse(stdout)).toEqual({ args: ["--demo", "--json", "status"] });
    } finally {
      rmSync(files.root, { recursive: true, force: true });
    }
  }, 30_000);

  registryTest("fails when a platform helper is missing", () => {
    const files = fixture();
    try {
      const platform = platformFixtures[2];
      const stage = path.join(files.root, platform.directory);
      rmSync(path.join(stage, "package", "runtime", platform.helper));
      const archive = path.join(files.assets, `baasx-${manifest.version}-${platform.asset}-bun.tgz`);
      execFileSync("tar", ["-czf", archive, "-C", stage, "package"]);
      expect(() => pack(files)).toThrow("missing package/runtime/baas-cli-runtime.exe");
    } finally {
      rmSync(files.root, { recursive: true, force: true });
    }
  }, 30_000);
});
