import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLinuxRelease } from "../../scripts/normalize-linux-release.mjs";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function fixture(machine = 62) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baas-linux-artifacts-"));
  temporary.push(root);
  const bundleDir = path.join(root, "bundle");
  const files: Record<string, string> = {};
  for (const [directory, extension] of [["deb", ".deb"], ["rpm", ".rpm"], ["appimage", ".AppImage"]]) {
    const folder = path.join(bundleDir, directory);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, "Tauri generated file with spaces" + extension);
    const bytes = Buffer.alloc(32, 1);
    if (extension === ".AppImage") {
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
      Buffer.from([0x41, 0x49, 0x02]).copy(bytes, 8);
      bytes.writeUInt16LE(machine, 18);
    }
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(file + ".sig", "fixture signature for " + extension);
    files[directory] = file;
  }
  return { root, files, options: { version: "1.2.3.post1", target: "x86_64-unknown-linux-gnu", bundleDir, assetsDir: path.join(root, "assets") } };
}

test("Linux release normalization preserves raw AppImage payloads and their signatures for both architectures", () => {
  for (const [target, machine, arch, deb] of [
    ["x86_64-unknown-linux-gnu", 62, "x86_64", "amd64"],
    ["aarch64-unknown-linux-gnu", 183, "aarch64", "arm64"],
  ] as const) {
    const { options, files } = fixture(machine);
    // An old updater archive must never replace the signed raw v2 payload.
    fs.writeFileSync(files.appimage + ".tar.gz", "obsolete archive");
    const outputs = normalizeLinuxRelease({ ...options, target });
    const basename = (suffix: string) => `BAAS.Tauri_1.2.3.post1_${suffix}`;
    expect(outputs.map(file => path.basename(file))).toEqual([
      basename(deb + ".deb"), basename(deb + ".deb.sig"),
      basename(arch + ".rpm"), basename(arch + ".rpm.sig"),
      basename(arch + ".AppImage"), basename(arch + ".AppImage.sig"),
    ]);
    const image = outputs[4];
    expect(fs.readFileSync(image)).toEqual(fs.readFileSync(files.appimage));
    expect(fs.readFileSync(image + ".sig", "utf8")).toBe("fixture signature for .AppImage");
    expect(fs.statSync(image).mode & 0o111).toBe(0o111);
  }
});

test("Linux normalization rejects wrong-architecture images, missing signatures and ambiguous outputs before replacing assets", () => {
  for (const mutate of [
    (files: Record<string, string>) => fs.unlinkSync(files.appimage + ".sig"),
    (files: Record<string, string>) => fs.writeFileSync(files.appimage + ".sig", " "),
    (files: Record<string, string>) => fs.writeFileSync(files.appimage, "archive instead of ELF"),
    (files: Record<string, string>) => { const bytes = fs.readFileSync(files.appimage); bytes.writeUInt16LE(183, 18); fs.writeFileSync(files.appimage, bytes); },
    (files: Record<string, string>) => fs.copyFileSync(files.appimage, path.join(path.dirname(files.appimage), "duplicate.AppImage")),
  ]) {
    const { options, files } = fixture();
    fs.mkdirSync(options.assetsDir);
    const previous = path.join(options.assetsDir, "previous output");
    fs.writeFileSync(previous, "preserve");
    mutate(files);
    expect(() => normalizeLinuxRelease(options)).toThrow();
    expect(fs.readFileSync(previous, "utf8")).toBe("preserve");
  }
});

test("Linux normalization rejects unsupported client architectures", () => {
  const { options } = fixture();
  expect(() => normalizeLinuxRelease({ ...options, target: "armv7-unknown-linux-gnueabihf" })).toThrow("Unsupported Linux client target");
});
