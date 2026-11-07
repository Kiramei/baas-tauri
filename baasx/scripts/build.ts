import { mkdir, copyFile, chmod, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import manifest from "../package.json";

const root = resolve(import.meta.dir, "../..");
const cli = resolve(import.meta.dir, "..");
const binary = process.argv.includes("--binary");
const trim = binary && !process.argv.includes("--no-trim");
const name = process.platform === "win32" ? "baas-cli-runtime.exe" : "baas-cli-runtime";
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
if (binary) {
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
