import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { ensureRegistryPackage } from "../scripts/registry-check.mjs";

const info = { name: "@kiramei/baasx", version: "0.1.2", integrity: "sha512-expected" };

test("Windows publication invokes npm through Node with the archive as one argument", () => {
  const root = mkdtempSync(path.join(tmpdir(), "baasx publish "));
  try {
    const node = path.join(root, "node.exe");
    const npm = path.join(root, "node_modules", "npm", "bin", "npm-cli.js");
    const guard = path.join(root, "capture.cjs");
    const archive = path.join(root, "runtime & cli.tgz");
    const packages = path.join(root, "packages.json");
    const registry = "https://registry.npmjs.org/";
    mkdirSync(path.dirname(npm), { recursive: true });
    writeFileSync(npm, "");
    writeFileSync(packages, JSON.stringify([{ ...info, archive }]));
    // Replace both registry I/O and process execution in this isolated Node process.
    writeFileSync(guard, `
      Object.defineProperty(process, "platform", { value: "win32" });
      Object.defineProperty(process, "execPath", { value: ${JSON.stringify(node)} });
      globalThis.fetch = async () => ({ status: 404 });
      require("node:child_process").execFileSync = (command, args) => {
        process.stdout.write(JSON.stringify([command, ...args]));
      };
      require("node:module").syncBuiltinESMExports();
    `);
    const script = fileURLToPath(new URL("../scripts/registry-publish.mjs", import.meta.url));
    const output = execFileSync(
      "node",
      ["--require", guard, script, "--info", packages, "--registry", registry, "--tag", "next"],
      { encoding: "utf8" }
    );
    expect(JSON.parse(output)).toEqual([
      node, npm, "publish", archive, "--ignore-scripts", "--registry", registry,
      "--access", "public", "--tag", "next",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unscoped package is skipped for both registries even with an older package list", () => {
  const root = mkdtempSync(path.join(tmpdir(), "baasx-unscoped-hold-"));
  try {
    const guard = path.join(root, "guard.cjs");
    const packages = path.join(root, "packages.json");
    writeFileSync(packages, JSON.stringify([{ name: "baasx", version: "0.1.4", integrity: "sha512-test", archive: "should-not-publish.tgz" }]));
    writeFileSync(guard, `
      globalThis.fetch = async () => { throw new Error("unscoped package must not be queried"); };
      require("node:child_process").execFileSync = () => { throw new Error("unscoped package must not be published"); };
      require("node:module").syncBuiltinESMExports();
    `);
    const script = fileURLToPath(new URL("../scripts/registry-publish.mjs", import.meta.url));
    for (const registry of ["https://registry.npmjs.org/", "https://npm.pkg.github.com/"]) {
      expect(execFileSync("node", ["--require", guard, script, "--info", packages, "--registry", registry], { encoding: "utf8" })).toBe("");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function response(status, metadata) {
  return { status, ok: status >= 200 && status < 300, json: async () => metadata };
}

describe("registry publication", () => {
  for (const registry of ["https://registry.npmjs.org/", "https://npm.pkg.github.com/"]) {
    test(`${registry} uses package metadata and keeps matching versions`, async () => {
      let publications = 0;
      const status = await ensureRegistryPackage({
        registry,
        info,
        token: "test-token",
        request: async (url, options) => {
          expect(url.href).toBe(`${registry}%40kiramei%2Fbaasx`);
          expect(options.headers.authorization).toBe("Bearer test-token");
          return response(200, { versions: { "0.1.2": { dist: { integrity: info.integrity } } } });
        },
        publish: () => { publications++; },
      });
      expect(status).toBe("matching");
      expect(publications).toBe(0);
    });

    test(`${registry} publishes a missing version or package`, async () => {
      for (const reply of [response(200, { versions: { "0.1.1": {} } }), response(404)]) {
        let publications = 0;
        const status = await ensureRegistryPackage({
          registry,
          info,
          request: async () => reply,
          publish: () => { publications++; },
        });
        expect(status).toBe("published");
        expect(publications).toBe(1);
      }
    });
  }

  test("different integrity fails without publishing", async () => {
    let publications = 0;
    await expect(ensureRegistryPackage({
      registry: "https://npm.pkg.github.com/",
      info,
      request: async () => response(200, { versions: { "0.1.2": { dist: { integrity: "sha512-other" } } } }),
      publish: () => { publications++; },
    })).rejects.toThrow("already exists with different contents");
    expect(publications).toBe(0);
  });

  test("registry errors or malformed metadata cannot trigger publishing", async () => {
    for (const reply of [response(401), response(405), response(500), response(200, {}), response(200, { versions: [] })]) {
      let publications = 0;
      await expect(ensureRegistryPackage({
        registry: "https://npm.pkg.github.com/",
        info,
        request: async () => reply,
        publish: () => { publications++; },
      })).rejects.toThrow();
      expect(publications).toBe(0);
    }
  });

  test("missing local integrity never accepts a registry version", async () => {
    let publications = 0;
    await expect(ensureRegistryPackage({
      registry: "https://registry.npmjs.org/",
      info: { name: info.name, version: info.version },
      request: async () => response(200, { versions: { "0.1.2": { dist: {} } } }),
      publish: () => { publications++; },
    })).rejects.toThrow("name, version and integrity");
    expect(publications).toBe(0);
  });
});

test("backfilling older versions preserves both stable and numeric prerelease pointers", async () => {
  for (const [version,tag,previous,expected] of [
    ["0.1.2","latest","0.2.0","historical"],
    ["0.1.2-rc.9","next","0.1.2-rc.10","historical"],
    ["0.1.2-rc.10","next","0.1.2-rc.9","next"],
    ["0.1.2","latest","0.1.2-rc.1","latest"],
  ]) {
    const calls=[];
    await ensureRegistryPackage({tag, registry:"https://registry.npmjs.org/",info:{...info,version},
      request:async()=>response(200, {versions:{}, "dist-tags":{[tag]:previous}}),
      publish:target=>calls.push(target)});
    expect(calls).toEqual([expected]);
  }
});
