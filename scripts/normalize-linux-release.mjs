import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseReleaseVersion } from "../src/shared/ReleaseVersion.mjs";

const targets = {
  "x86_64-unknown-linux-gnu": { deb: "amd64", rpm: "x86_64", appimage: "x86_64", machine: 62 },
  "aarch64-unknown-linux-gnu": { deb: "arm64", rpm: "aarch64", appimage: "aarch64", machine: 183 },
};

/** Tauri v2 signs the raw AppImage, alongside the DEB and RPM, in a single build. */
export function normalizeLinuxRelease({ version, target, bundleDir, assetsDir }) {
  if (!parseReleaseVersion(version)) throw new Error("Expected a canonical release version");
  const arch = targets[target];
  if (!arch) throw new Error("Unsupported Linux client target: " + target);
  const pairs = [
    ["deb", ".deb", arch.deb],
    ["rpm", ".rpm", arch.rpm],
    ["appimage", ".AppImage", arch.appimage],
  ].map(([directory, extension, name]) => {
    const root = path.join(bundleDir, directory);
    const matches = fs.readdirSync(root).filter(file => file.endsWith(extension));
    if (matches.length !== 1) throw new Error(`Expected exactly one ${extension} bundle in ${root}`);
    const source = path.join(root, matches[0]);
    if (!fs.statSync(source).isFile() || !fs.statSync(source).size)
      throw new Error("Empty release bundle: " + source);
    const signature = source + ".sig";
    if (!fs.readFileSync(signature, "utf8").trim()) throw new Error("Empty updater signature: " + signature);
    if (extension === ".AppImage") {
      const header = Buffer.alloc(20);
      const fd = fs.openSync(source, "r");
      try { fs.readSync(fd, header, 0, header.length, 0); }
      finally { fs.closeSync(fd); }
      if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
          header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== arch.machine ||
          !header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02])))
        throw new Error("Expected a raw type-2 AppImage for " + target);
    }
    return { source, signature, name: `BAAS.Tauri_${version}_${name}${extension}` };
  });
  // Validate every artifact before replacing any previously normalized output.
  fs.rmSync(assetsDir, { recursive: true, force: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  return pairs.flatMap(({ source, signature, name }) => {
    const output = path.join(assetsDir, name);
    fs.copyFileSync(source, output);
    if (name.endsWith(".AppImage")) fs.chmodSync(output, 0o755);
    fs.copyFileSync(signature, output + ".sig");
    return [output, output + ".sig"];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { "--version": "version", "--target": "target", "--bundle-dir": "bundleDir", "--assets-dir": "assetsDir" }[args[i]];
    if (!key || !args[i + 1]) throw new Error("Expected --version, --target, --bundle-dir and --assets-dir");
    options[key] = args[i + 1];
  }
  console.log(normalizeLinuxRelease(options).join("\n"));
}
