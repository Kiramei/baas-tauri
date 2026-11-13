import { describe, expect, test } from "bun:test";
import { ensureRegistryPackage } from "../scripts/registry-check.mjs";

const info = { name: "@kiramei/baasx", version: "0.1.2", integrity: "sha512-expected" };

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
