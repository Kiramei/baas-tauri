import { URL } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { platforms } from "./distribution-platforms.mjs";

const packages = JSON.parse(await readFile(process.argv[2], "utf8"));
const scratch = await mkdtemp(path.join(tmpdir(), "baasx-install-smoke-"));
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
    const manifest = JSON.parse(await run("tar", ["-xOzf", pkg.archive, "package/package.json"]));
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
  // Both bare and scoped package resolution must use the fixture registry even if
  // actions/setup-node configured a scoped production registry on this runner.
  const config = path.join(scratch, "npmrc");
  await writeFile(config, `registry=${registry}\n@kiramei:registry=${registry}\n`);
  const matching = platforms.find((p) => p.os === process.platform && p.cpu === process.arch);
  assert.ok(matching);
  for (const name of ["@kiramei/baasx", "baasx"]) {
    const prefix = path.join(scratch, "npm-install-" + name.replaceAll("/", "-"));
    requested.clear();
    await run(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        name,
      ],
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
    const executable = path.join(prefix, "bin", "baasx");
    await run(executable, ["--demo", "--json", "status"]);
    // The installed entry point resolves the package's exported native helper.
    const packageDir = path.join(prefix, "lib/node_modules", name);
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
    const text = await run(resolved, ["inspect", "--root", path.join(scratch, "missing-runtime")]);
    assert.equal(JSON.parse(text.trim()).type, "result");
  }
  if (process.env.BAASX_SMOKE_BUN) {
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
      ["add", "-g", "baasx", "--ignore-scripts"],
      options,
      scratch
    );
    await run(path.join(bin, "baasx"), ["--demo", "--json", "status"], options);
    assert.ok(requested.has(matching.name), "Bun did not request its matching optional runtime");
    for (const other of platforms.filter((p) => p !== matching))
      assert.ok(!requested.has(other.name), `Bun downloaded foreign helper ${other.name}`);
  }
} finally {
  await new Promise((done) => server.close(done));
  await rm(scratch, { recursive: true, force: true });
}
