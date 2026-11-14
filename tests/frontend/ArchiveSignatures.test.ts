import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readArchiveSignatureMetadata, writeArchiveSignatureMetadata } from "../../scripts/archive-signatures.mjs";
import { signedReleasePlatforms } from "../../scripts/release-feed.mjs";

const tag = "0.0.11";
const filename = (arch: string, version = tag) => `BAAS.Tauri_${version}_${arch}.app.tar.gz`;
const asset = (name: string) => ({ name, browser_download_url: `https://example.invalid/${name}` });
const metadata = (arch: string, version = tag) => ({ schema_version: 1, tag: version, signatures: { [filename(arch, version)]: "signed:" + arch } });

test("parallel macOS architectures persist independent metadata without public archive .sig files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-signatures-"));
  try {
    const uploads = path.join(root, "uploads");
    fs.mkdirSync(uploads);
    for (const arch of ["aarch64", "x64"]) {
      const archive = path.join(uploads, filename(arch));
      const signature = path.join(root, `${arch}.app.tar.gz.sig`);
      const output = path.join(uploads, `updater-signatures-${arch}.json`);
      fs.writeFileSync(archive, "archive fixture");
      fs.writeFileSync(signature, "signed:" + arch + "\n");
      expect(writeArchiveSignatureMetadata({ tag, arch, archive, signature, output })).toEqual(metadata(arch));
      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual(metadata(arch));
      expect(fs.existsSync(signature)).toBe(true);
      expect(() => writeArchiveSignatureMetadata({ tag, arch, archive, signature, output })).toThrow();
    }
    expect(fs.readdirSync(uploads)).toHaveLength(4);
    expect(fs.readdirSync(uploads).some(name => name.endsWith(".sig"))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("metadata must match the exact tag, archive filename and one nonempty signature", () => {
  const expected = { tag, filename: filename("aarch64") };
  for (const bad of [null, [], {}, { ...metadata("aarch64"), schema_version: 2 }, metadata("x64"),
    metadata("aarch64", "0.0.10"), { ...metadata("aarch64"), signatures: [] },
    ...["", " ", 1, null, "x".repeat(16385)].map(value => ({ ...metadata("aarch64"), signatures: { [expected.filename]: value } })),
    { ...metadata("aarch64"), signatures: { ...metadata("aarch64").signatures, other: "sig" } },
  ]) expect(() => readArchiveSignatureMetadata(bad, expected)).toThrow();
  expect(readArchiveSignatureMetadata(metadata("aarch64"), expected)).toBe("signed:aarch64");
});

test("future archive feeds require persistent metadata and never fall back to public .sig files", async () => {
  const release = { tag_name: tag, assets: [asset(filename("aarch64")), asset(filename("aarch64") + ".sig")] };
  await expect(signedReleasePlatforms(release)).rejects.toThrow("Missing persistent archive signature metadata");
  release.assets.push(asset("updater-signatures-aarch64.json"));
  expect(await signedReleasePlatforms(release, { fetchSignature: async () => Response.json(metadata("aarch64")) })).toEqual({
    "darwin-aarch64": { url: asset(filename("aarch64")).browser_download_url, signature: "signed:aarch64" },
  });
  for (const fetchSignature of [
    async () => new Response("error", { status: 502 }),
    async () => { throw new Error("network unavailable"); },
    async () => new Response("invalid JSON"),
    async () => Response.json(metadata("x64")),
    async () => Response.json(metadata("aarch64", "0.0.10")),
  ]) await expect(signedReleasePlatforms(release, { fetchSignature })).rejects.toThrow();
});

test("historical archive signatures remain readable, while present metadata errors stay fatal", async () => {
  const old = "0.0.10", name = filename("aarch64", old);
  const release = { tag_name: old, assets: [asset(name), asset(name + ".sig")] };
  expect(await signedReleasePlatforms(release, { fetchSignature: async () => new Response("legacy signature") })).toEqual({
    "darwin-aarch64": { url: asset(name).browser_download_url, signature: "legacy signature" },
  });
  release.assets.push(asset("updater-signatures-aarch64.json"));
  await expect(signedReleasePlatforms(release, { fetchSignature: async () => new Response("missing", { status: 404 }) })).rejects.toThrow("HTTP 404");
  await expect(signedReleasePlatforms(release, { fetchSignature: async () => Response.json(metadata("aarch64")) })).rejects.toThrow("release tag");
});

test("both macOS archive feed targets resolve their own persistent signature", async () => {
  const release = { tag_name: tag, assets: ["aarch64", "x64"].flatMap(arch => [asset(filename(arch)), asset(`updater-signatures-${arch}.json`)]) };
  const platforms = await signedReleasePlatforms(release, { fetchSignature: async (url: string) => Response.json(metadata(url.includes("aarch64") ? "aarch64" : "x64")) });
  expect(platforms["darwin-aarch64"].signature).toBe("signed:aarch64");
  expect(platforms["darwin-x86_64"].signature).toBe("signed:x64");
  expect(platforms["darwin-intel"]).toEqual(platforms["darwin-x86_64"]);
});
