import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Official Node.js ARMv7 release, pinned to its published SHA-256 digest.
// https://nodejs.org/en/blog/release/v22.23.5
export const nodeRuntime = Object.freeze({
  version: "22.23.5",
  archive: "node-v22.23.5-linux-armv7l.tar.xz",
  sha256: "1c3e15d38e4cafbbf74377ac070cd9d7e0418c673e1f6332f38f1d4762a699f9",
});

export async function installNodeRuntime(destination) {
  const temp = await mkdtemp(join(tmpdir(), "baasx-node-runtime-"));
  try {
    const response = await globalThis.fetch(`https://nodejs.org/dist/v${nodeRuntime.version}/${nodeRuntime.archive}`);
    if (!response.ok) throw new Error(`Node.js download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== nodeRuntime.sha256)
      throw new Error("Official Node.js archive checksum mismatch");
    const archive = join(temp, nodeRuntime.archive);
    await writeFile(archive, bytes);
    const directory = nodeRuntime.archive.replace(/\.tar\.xz$/, "");
    execFileSync("tar", ["-xJf", archive, "-C", temp, `${directory}/bin/node`, `${directory}/LICENSE`]);
    // Check ELF32, little endian and EM_ARM before adding an executable to the release.
    const executable = await readFile(join(temp, directory, "bin/node"));
    if (!executable.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        executable[4] !== 1 || executable[5] !== 1 || executable.readUInt16LE(18) !== 40)
      throw new Error("Official Node.js archive did not contain an ARM32 ELF executable");
    await mkdir(destination, { recursive: true });
    await copyFile(join(temp, directory, "bin/node"), join(destination, "node"));
    await chmod(join(destination, "node"), 0o755);
    await copyFile(join(temp, directory, "LICENSE"), join(destination, "NODE_LICENSE"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
