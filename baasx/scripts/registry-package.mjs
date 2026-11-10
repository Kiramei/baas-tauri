import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    assets: { type: "string" },
    bundle: { type: "string" },
    output: { type: "string" },
    scope: { type: "string" },
  },
});
if (!values.assets || !values.bundle || !values.output || values.scope !== "kiramei") {
  throw new Error("Provide --assets <release directory> --bundle <Node bundle> --output <directory> --scope kiramei");
}
const assets = path.resolve(values.assets);
const output = path.resolve(values.output);
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const platforms = [
  { asset: "Linux-X64", directory: "linux-x64", helper: "baas-cli-runtime" },
  {
    asset: "macOS-ARM64",
    directory: "darwin-arm64",
    helper: "baas-cli-runtime",
  },
  {
    asset: "Windows-X64",
    directory: "win32-x64",
    helper: "baas-cli-runtime.exe",
  },
];
const temporary = mkdtempSync(path.join(tmpdir(), "baasx-registry-"));
try {
  const stage = path.join(temporary, "package");
  mkdirSync(path.join(stage, "bin"), { recursive: true });
  mkdirSync(path.join(stage, "dist"), { recursive: true });
  copyFileSync(path.join(root, "registry/baasx.mjs"), path.join(stage, "bin/baasx.mjs"));
  copyFileSync(path.resolve(values.bundle), path.join(stage, "dist/baasx-node.mjs"));
  for (const file of ["README.md", "README_zh.md", "LICENSE"])
    copyFileSync(path.join(root, file), path.join(stage, file));
  for (const platform of platforms) {
    const archive = path.join(assets, `baasx-${manifest.version}-${platform.asset}-bun.tgz`);
    if (!existsSync(archive)) throw new Error(`Missing verified release archive: ${archive}`);
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n");
    for (const required of [`package/runtime/${platform.helper}`]) {
      if (!entries.includes(required) && !entries.includes(`./${required}`))
        throw new Error(`${archive} is missing ${required}`);
    }
    const destination = path.join(stage, "platforms", platform.directory);
    mkdirSync(destination, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      archive,
      "-C",
      destination,
      "--strip-components=1",
      `package/runtime/${platform.helper}`,
    ]);
    if (platform.directory !== "win32-x64") {
      chmodSync(path.join(destination, "runtime", platform.helper), 0o755);
    }
  }
  const published = {
    name: `@${values.scope}/baasx`,
    version: manifest.version,
    description: manifest.description,
    license: manifest.license,
    repository: {
      type: "git",
      url: "git+https://github.com/Kiramei/baas-tauri.git",
      directory: "baasx",
    },
    homepage: "https://github.com/Kiramei/baas-tauri/tree/dev/baasx#readme",
    bugs: { url: "https://github.com/Kiramei/baas-tauri/issues" },
    bin: { baasx: "bin/baasx.mjs" },
    engines: { node: ">=20.3.0" },
    os: ["darwin", "linux", "win32"],
    cpu: ["arm64", "x64"],
    files: ["bin", "dist", "platforms", "README.md", "README_zh.md", "LICENSE"],
  };
  writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
  mkdirSync(output, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = execFileSync(
    npm,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", output],
    { cwd: stage, encoding: "utf8" }
  );
  const result = JSON.parse(packed)[0];
  console.log(
    JSON.stringify({
      name: published.name,
      version: published.version,
      archive: path.join(output, result.filename),
      integrity: result.integrity,
    })
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
