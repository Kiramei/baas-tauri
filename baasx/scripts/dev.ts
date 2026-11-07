import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "../..");
const filename = process.platform === "win32" ? "baas-cli-runtime.exe" : "baas-cli-runtime";
if (!process.env.BAAS_RUNTIME_HELPER) {
  // Source development always checks Rust's incremental build, so an older
  // release helper in baasx/runtime cannot silently hide current installer edits.
  const build = Bun.spawn(["cargo", "build", "--locked", "-p", "baas-cli-runtime"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await build.exited) process.exit(1);
  const metadata = Bun.spawn(["cargo", "metadata", "--locked", "--no-deps", "--format-version=1"], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  });
  const metadataText = await new Response(metadata.stdout).text();
  if (await metadata.exited) process.exit(1);
  const targetDirectory: unknown = JSON.parse(metadataText).target_directory;
  if (typeof targetDirectory !== "string")
    throw new Error("Cargo did not return its target directory");
  process.env.BAAS_RUNTIME_HELPER = join(
    targetDirectory,
    ...(process.env.CARGO_BUILD_TARGET ? [process.env.CARGO_BUILD_TARGET] : []),
    "debug",
    filename
  );
}
await import("../src/index");
