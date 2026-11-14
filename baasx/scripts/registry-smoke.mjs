import { URL } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { npmCommand } from "./host-npm.mjs";
import { platformFor, platforms } from "./distribution-platforms.mjs";

// Git Bash's GNU tar interprets "D:" as a remote host. Windows bsdtar
// takes native drive paths for both input archives and extraction directories.
const tar =
  process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: "string" },
    "install-only": { type: "boolean", default: false },
  },
});
const matching = values.target
  ? platformFor(values.target)
  : platformFor(process.platform, process.arch);
assert.ok(matching, "Unknown smoke test target");
const host = matching.os === process.platform && matching.cpu === process.arch;
assert.ok(host || values["install-only"], "A foreign target requires --install-only");
const packages = JSON.parse(await readFile(positionals[0], "utf8"));
const scratch = await mkdtemp(path.join(tmpdir(), "baasx-install-smoke-"));
// A caller may place TMPDIR inside the checkout. Stop Bun discovering the
// repository's workspace manifest while installing against the fixture registry.
await writeFile(path.join(scratch, "package.json"), '{"private":true}\n');
const requested = new Set();
async function run(command, args, extra = {}, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} failed (${code}): ${stderr}`))
    );
  });
}
const metadata = new Map();
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const entry = packages.find((p) => "/tarballs/" + path.basename(p.archive) === url.pathname);
  if (entry) {
    requested.add(entry.name);
    res.setHeader("content-type", "application/octet-stream");
    createReadStream(entry.archive).pipe(res);
    return;
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!metadata.has(name)) {
    res.writeHead(404);
    res.end("{}");
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(metadata.get(name)));
});
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const registry = `http://127.0.0.1:${server.address().port}/`;
  for (const pkg of packages) {
    const manifest = JSON.parse(await run(tar, ["-xOzf", pkg.archive, "package/package.json"]));
    manifest.dist = {
      tarball: registry + "tarballs/" + path.basename(pkg.archive),
      integrity: pkg.integrity,
    };
    metadata.set(pkg.name, {
      name: pkg.name,
      "dist-tags": { latest: pkg.version },
      versions: { [pkg.version]: manifest },
    });
  }
  // Package resolution must use the fixture registry even if
  // actions/setup-node configured a scoped production registry on this runner.
  const config = path.join(scratch, ".npmrc");
  await writeFile(config, `registry=${registry}\n@kiramei:registry=${registry}\n`);
  for (const name of ["@kiramei/baasx"]) {
    const prefix = path.join(scratch, "npm-install-" + name.replaceAll("/", "-"));
    requested.clear();
    const [npm, ...installArgs] = npmCommand([
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--os",
      matching.os,
      "--cpu",
      matching.cpu,
      name,
    ]);
    await run(
      npm,
      installArgs,
      {
        NPM_CONFIG_USERCONFIG: config,
        npm_config_userconfig: config,
        npm_config_cache: prefix + "-cache",
      },
      scratch
    );
    assert.ok(requested.has(matching.name), "Host helper was not downloaded");
    for (const other of platforms.filter((p) => p !== matching))
      assert.ok(!requested.has(other.name), `Downloaded foreign helper ${other.name}`);
    if (values["install-only"]) continue;
    if (process.platform === "win32") {
      // Exercise the actual npm-installed command shim through cmd.exe.
      await run(
        "cmd.exe",
        ["/d", "/c", "baasx.cmd --demo --json status"],
        {
          PATH: prefix + path.delimiter + process.env.PATH,
        },
        scratch
      );
    } else {
      await run(path.join(prefix, "bin/baasx"), ["--demo", "--json", "status"]);
    }
    // The installed entry point resolves the package's exported native helper.
    const packageDir = path.join(
      prefix,
      process.platform === "win32" ? "node_modules" : "lib/node_modules",
      name
    );
    const resolved = JSON.parse(
      await run("node", [
        "--input-type=commonjs",
        "-e",
        `
      const path=require('node:path'), {createRequire}=require('node:module');
      const root=createRequire(path.join(process.argv[1],'package.json'));
      const cli=process.argv[2]==='baasx'?root.resolve('@kiramei/baasx/cli'):path.join(process.argv[1],'bin','baasx.mjs');
      console.log(JSON.stringify(createRequire(cli).resolve(process.argv[3]+'/helper')));
    `,
        packageDir,
        name,
        matching.name,
      ])
    );
    const inspectArgs = ["inspect", "--root", path.join(scratch, "missing runtime 测试")];
    const text = await run(resolved, inspectArgs);
    assert.equal(JSON.parse(text.trim()).type, "result");
    const legacy = path.join(path.dirname(resolved), matching.legacyHelper);
    assert.deepEqual(JSON.parse(await run(legacy, inspectArgs)), JSON.parse(text));
  }
  if (process.env.BAASX_SMOKE_BUN && !values["install-only"]) {
    const prefix = path.join(scratch, "bun-install");
    const bin = path.join(prefix, "bin");
    await writeFile(
      path.join(scratch, "bunfig.toml"),
      `[install]\nregistry = "${registry}"\nglobalDir = ${JSON.stringify(prefix + "/global")}\nglobalBinDir = ${JSON.stringify(bin)}\n`
    );
    requested.clear();
    const options = {
      NPM_CONFIG_USERCONFIG: config,
      npm_config_userconfig: config,
      BUN_INSTALL: prefix,
      BUN_INSTALL_CACHE_DIR: prefix + "/cache",
      BUN_CONFIG_REGISTRY: registry,
      PATH: bin + path.delimiter + process.env.PATH,
    };
    await run(
      process.env.BAASX_SMOKE_BUN,
      ["add", "-g", "@kiramei/baasx", "--ignore-scripts"],
      options,
      scratch
    );
    await run(
      path.join(bin, process.platform === "win32" ? "baasx.exe" : "baasx"),
      ["--demo", "--json", "status"],
      options
    );
    assert.ok(requested.has(matching.name), "Bun did not request its matching optional runtime");
    for (const other of platforms.filter((p) => p !== matching))
      assert.ok(!requested.has(other.name), `Bun downloaded foreign helper ${other.name}`);
  }
} finally {
  await new Promise((done) => server.close(done));
  await rm(scratch, { recursive: true, force: true });
}
