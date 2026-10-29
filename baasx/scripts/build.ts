import { mkdir, copyFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BunPlugin } from "bun";

const root = resolve(import.meta.dir, "../..");
const cli = resolve(import.meta.dir, "..");
const binary = process.argv.includes("--binary");
const name = process.platform === "win32" ? "baas-cli-runtime.exe" : "baas-cli-runtime";

// Ink 6 conditionally imports an optional React DevTools peer. Bun traverses
// that import before removing its DEV branch, even in production builds.
// Disable only Ink's development adapter; release artifacts need no devtools
// dependency, browser polyfills, or connection to a debugging server.
const withoutInkDevtools: BunPlugin = {
  name: "baas-release-without-ink-devtools",
  setup(builder) {
    builder.onResolve({ filter: /^\.\/devtools\.js$/ }, (args) => {
      if (args.importer.replaceAll("\\", "/").endsWith("/ink/build/reconciler.js"))
        return { path: "disabled", namespace: "baas-no-devtools" };
    });
    builder.onLoad({ filter: /^disabled$/, namespace: "baas-no-devtools" }, () => ({
      contents: "export {};",
      loader: "js",
    }));
  },
};

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
const build = Bun.spawn(["cargo", "build", "--release", "--locked", "-p", "baas-cli-runtime"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (await build.exited) process.exit(1);
for (const directory of [join(cli, "runtime"), join(cli, "dist/runtime")]) {
  await mkdir(directory, { recursive: true });
  const target = join(directory, name);
  await copyFile(
    join(
      targetDirectory,
      ...(process.env.CARGO_BUILD_TARGET ? [process.env.CARGO_BUILD_TARGET] : []),
      "release",
      name
    ),
    target
  );
  if (process.platform !== "win32") await chmod(target, 0o755);
}
const result = await Bun.build({
  entrypoints: [join(cli, "src/index.ts")],
  target: "bun",
  outdir: join(cli, "dist"),
  naming: "baasx.js",
  define: {
    "process.env.DEV": '"false"',
    "process.env.NODE_ENV": '"production"',
  },
  plugins: [withoutInkDevtools],
});
for (const message of result.logs) console.error(message);
if (!result.success) process.exit(1);
if (binary) {
  const compiled = Bun.spawn(
    [
      process.execPath,
      "build",
      "dist/baasx.js",
      "--compile",
      `--outfile=dist/baasx${process.platform === "win32" ? ".exe" : ""}`,
    ],
    { cwd: cli, stdout: "inherit", stderr: "inherit" }
  );
  process.exitCode = await compiled.exited;
}
