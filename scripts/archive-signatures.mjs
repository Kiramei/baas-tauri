import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { compareReleaseVersions, parseReleaseVersion } from "../src/shared/ReleaseVersion.mjs";

export function historicalClientRelease(tag) {
  const parsed = parseReleaseVersion(tag, { allowLegacy: true });
  return Boolean(parsed && compareReleaseVersions(parsed.canonical, "0.0.10") <= 0);
}

export function archiveSignatureAsset(suffix) {
  return { "aarch64.app.tar.gz": "updater-signatures-aarch64.json", "x64.app.tar.gz": "updater-signatures-x64.json" }[suffix];
}

export function readArchiveSignatureMetadata(data, { tag, filename }) {
  // The client verifies this signature against the downloaded archive; this checks its envelope.
  if (!data || data.schema_version !== 1 || data.tag !== tag || !data.signatures ||
      typeof data.signatures !== "object" || Array.isArray(data.signatures) ||
      Object.keys(data.signatures).length !== 1 || !Object.hasOwn(data.signatures, filename))
    throw new Error("Archive signature metadata does not match the release tag and archive filename");
  const signature = data.signatures[filename];
  if (typeof signature !== "string" || !signature.trim() || signature.length > 16384)
    throw new Error("Missing or invalid archive signature metadata");
  return signature.trim();
}

/** Each architecture writes one persistent release asset; parallel builds never share a file. */
export function writeArchiveSignatureMetadata({ tag, arch, archive, signature, output }) {
  const version = parseReleaseVersion(tag, { allowLegacy: true });
  if (!version || !["aarch64", "x64"].includes(arch)) throw new Error("Invalid archive signature target");
  const filename = `BAAS.Tauri_${tag.replace(/^v/, "")}_${arch}.app.tar.gz`;
  if (archive.split(/[\\/]/).at(-1) !== filename || !fs.statSync(archive).isFile() || !fs.statSync(archive).size)
    throw new Error("Expected the normalized macOS updater archive");
  const data = { schema_version: 1, tag, signatures: { [filename]: fs.readFileSync(signature, "utf8").trim() } };
  readArchiveSignatureMetadata(data, { tag, filename });
  fs.writeFileSync(output, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { "--tag": "tag", "--arch": "arch", "--archive": "archive", "--signature": "signature", "--output": "output" }[args[i]];
    if (!key || !args[i + 1]) throw new Error("Expected tag, arch, archive, signature and output arguments");
    options[key] = args[i + 1];
  }
  writeArchiveSignatureMetadata(options);
}
