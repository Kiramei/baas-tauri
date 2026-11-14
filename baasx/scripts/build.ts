import { mkdir, copyFile, chmod, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import manifest from "../package.json";
import { platformFor } from "./distribution-platforms.mjs";
import { installNodeRuntime } from "./node-runtime.mjs";

const root = resolve(import.meta.dir, "../..");
const cli = resolve(import.meta.dir, "..");
const binary = process.argv.includes("--binary");
const jsOnly = process.argv.includes("--js-only");
const requestedTarget = process.argv.find((arg) => arg.startsWith("--target="))?.slice(9);
const platform = platformFor(requestedTarget || `${process.platform}-${process.arch}`);
if (!platform) throw new Error(`Unsupported BAASX target: ${requestedTarget}`);
const nodeBinary = binary && platform.runtime === "node";
if (nodeBinary && process.platform !== "linux")
  throw new Error("Linux ARM32 cross builds require a Linux host with the ARM hard-float toolchain.");
if (requestedTarget && !nodeBinary && requestedTarget !== `${process.platform}-${process.arch}`)
  throw new Error("Only Linux ARM32 uses cross compilation; build other targets on their native runners.");
if (binary && jsOnly) throw new Error("--binary and --js-only are mutually exclusive");
const trim = binary && !nodeBinary && !process.argv.includes("--no-trim");
const suffix = platform.os === "win32" ? ".exe" : "";
const name = "baasx-runtime" + suffix;
const legacyName = "baas-cli-runtime" + suffix;
const compilerRevision = "b1007f1177fd402fae67387b8548cae5ae9b5707";

if (!Bun.semver.satisfies(Bun.version, ">=1.4.4-0"))
  throw new Error(`baasx builds require Bun 1.4.4 or newer; use ${manifest.packageManager}.`);
if (Bun.revision !== compilerRevision && !process.argv.includes("--no-trim"))
  throw new Error(
    `baasx builds are pinned to ${manifest.packageManager} (${compilerRevision}). ` +
      `Run: npm exec --yes --package=${manifest.packageManager} -- bun run baasx:${binary ? "binary" : "build"}. ` +
      `Use --no-trim only for an explicit full-runtime fallback.`
  );
if (trim) {
  // Stable 1.4.4 silently ignores unknown build flags. Check the advertised
  // capability instead of allowing an unexpectedly large release artifact.
  const help = Bun.spawnSync([process.execPath, "build", "--help"]);
  if (help.exitCode !== 0 || !/--trim\s/.test(help.stdout.toString()))
    throw new Error(
      `Slim binaries require ${manifest.packageManager}. Use --no-trim for a full-runtime build.`
    );
}

// These APIs are not used by baasx or its bundled dependencies. Keep the JIT,
// interpreter (Ajv), WebAssembly (Yoga/libsodium), Intl, networking, crypto and
// process APIs. Command packs contain declarative JSON, not arbitrary JS plugins.
const unusedRuntimeFeatures = [
  "cli",
  "bundler",
  "test",
  "image",
  "webview",
  "sqlite",
  "sql",
  "redis",
  "s3",
  "html-rewriter",
  "ffi",
  "markdown",
  "cron",
];

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

if (!jsOnly) {
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
  const rustTarget = nodeBinary ? platform.rustTarget : process.env.CARGO_BUILD_TARGET;
  const build = Bun.spawn(["cargo", "build", "--release", "--locked", "-p", "baasx-runtime", ...(rustTarget ? ["--target", rustTarget] : [])], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await build.exited) process.exit(1);
  const releaseDir = join(
    targetDirectory,
    ...(rustTarget ? [rustTarget] : []),
    "release"
  );
  const packagedRuntime = join(cli, "runtime");
  const standaloneRuntime = join(cli, "dist/runtime");
  for (const directory of [packagedRuntime, standaloneRuntime]) {
    await mkdir(directory, { recursive: true });
    await copyFile(join(releaseDir, name), join(directory, name));
    if (process.platform !== "win32") await chmod(join(directory, name), 0o755);
  }
  const legacy = join(packagedRuntime, legacyName);
  if (process.platform === "win32") {
    const source = join(cli, "scripts/platform/windows/runtime-alias.rs");
    const compileAlias = Bun.spawn(
      ["rustc", "--edition=2024", "-C", "opt-level=s", "-C", "strip=symbols", source, "-o", legacy],
      {
        stdout: "inherit",
        stderr: "inherit",
      }
    );
    if (await compileAlias.exited) process.exit(1);
  } else {
    await writeFile(legacy, '#!/bin/sh\nexec "${0%/*}/baasx-runtime" "$@"\n');
    await chmod(legacy, 0o755);
  }
  await copyFile(legacy, join(standaloneRuntime, legacyName));
}
const result = await Bun.build({
  entrypoints: [join(cli, "src/index.ts")],
  target: "bun",
  outdir: join(cli, "dist"),
  naming: "baasx.js",
  minify: true,
  sourcemap: "none",
  define: {
    "process.env.DEV": '"false"',
    "process.env.NODE_ENV": '"production"',
  },
  plugins: [withoutInkDevtools],
});
for (const message of result.logs) console.error(message);
if (!result.success) process.exit(1);

// Registry installs run on Node without embedding a separate Bun executable.
const nodeResult = await Bun.build({
  entrypoints: [join(cli, "src/node-entry.ts")],
  target: "node",
  format: "esm",
  outdir: join(cli, "dist"),
  naming: "baasx-node.mjs",
  minify: true,
  sourcemap: "none",
  define: {
    "process.env.DEV": '"false"',
    "process.env.NODE_ENV": '"production"',
  },
  plugins: [withoutInkDevtools],
});
for (const message of nodeResult.logs) console.error(message);
if (!nodeResult.success) process.exit(1);

if (nodeBinary) {
  const distribution = join(cli, "dist");
  await installNodeRuntime(join(distribution, "runtime"));
  await writeFile(join(distribution, "baasx"), '#!/bin/sh\nBAASX_FILE=$(readlink -f -- "$0") || exit 1\nBAASX_DIR=${BAASX_FILE%/*}\nexec "$BAASX_DIR/runtime/node" "$BAASX_DIR/dist/baasx-node.mjs" "$@"\n');
  await chmod(join(distribution, "baasx"), 0o755);
  await mkdir(join(distribution, "dist"), { recursive: true });
  await copyFile(join(distribution, "baasx-node.mjs"), join(distribution, "dist/baasx-node.mjs"));
  console.log(`baasx: Linux ARMv7 hard-float launcher, bundled Node.js and ${platform.rustTarget} helper`);
} else if (binary) {
  const outfile = join(cli, `dist/baasx${process.platform === "win32" ? ".exe" : ""}`);
  // Keep ESM/top-level await and precompile just the first function level: this
  // improves startup without embedding bytecode for every seldom-used editor.
  const compile = {
    outfile,
    autoloadBunfig: false,
    ...(trim ? { trim: { remove: unusedRuntimeFeatures } } : {}),
  };
  const compiled = await Bun.build({
    entrypoints: [join(cli, "dist/baasx.js")],
    target: "bun",
    format: "esm",
    minify: true,
    bytecode: true,
    bytecodeDepth: 1,
    sourcemap: "none",
    compile,
  });
  for (const message of compiled.logs) console.error(message);
  if (!compiled.success) process.exit(1);
  console.log(
    `baasx: ${(await stat(outfile)).size} bytes (Bun ${Bun.version}+${Bun.revision.slice(0, 9)}, ${trim ? "trimmed" : "full runtime"})`
  );
}
