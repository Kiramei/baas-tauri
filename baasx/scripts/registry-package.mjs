import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
import { npmCommand } from "./host-npm.mjs";
import { platforms } from "./distribution-platforms.mjs";

// Git Bash's GNU tar interprets "D:" as a remote host. Windows bsdtar
// takes native drive paths for both input archives and extraction directories.
const tar =
  process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    assets: { type: "string" },
    bundle: { type: "string" },
    output: { type: "string" },
    scope: { type: "string" },
    "host-only": { type: "boolean", default: false },
  },
});
if (!values.assets || !values.bundle || !values.output || values.scope !== "kiramei") {
  throw new Error(
    "Provide --assets <release directory> --bundle <Node bundle> --output <directory> --scope kiramei"
  );
}
const assets = path.resolve(values.assets);
const output = path.resolve(values.output);
const { version, license, description } = JSON.parse(
  readFileSync(path.join(project, "package.json"), "utf8")
);
const base = {
  version,
  license,
  repository: {
    type: "git",
    url: "git+https://github.com/Kiramei/baas-tauri.git",
    directory: "baasx",
  },
  homepage: "https://github.com/Kiramei/baas-tauri/tree/dev/baasx#readme",
  bugs: { url: "https://github.com/Kiramei/baas-tauri/issues" },
};
const temp = mkdtempSync(path.join(tmpdir(), "baasx-registry-"));
mkdirSync(output, { recursive: true });
const packages = [];
function pack(manifest, populate) {
  const stage = path.join(temp, manifest.name.replace("@", "").replace("/", "-"));
  mkdirSync(stage);
  populate(stage);
  copyFileSync(path.join(project, "LICENSE"), path.join(stage, "LICENSE"));
  writeFileSync(
    path.join(stage, "package.json"),
    JSON.stringify({ ...base, ...manifest }, null, 2) + "\n"
  );
  const [npm, ...args] = npmCommand([
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    output,
  ]);
  const [result] = JSON.parse(
    execFileSync(npm, args, {
      cwd: stage,
      encoding: "utf8",
    })
  );
  packages.push({
    name: manifest.name,
    version,
    archive: path.join(output, result.filename),
    integrity: result.integrity,
  });
}
function bin(stage, filename) {
  mkdirSync(path.join(stage, "bin"));
  const dest = path.join(stage, "bin/baasx.mjs");
  copyFileSync(path.join(project, "registry", filename), dest);
  chmodSync(dest, 0o755);
}

try {
  const targets = values["host-only"]
    ? platforms.filter((p) => p.os === process.platform && p.cpu === process.arch)
    : platforms;
  for (const platform of targets) {
    pack(
      {
        name: platform.name,
        description: `BAASX local runtime for ${platform.os}/${platform.cpu}`,
        os: [platform.os],
        cpu: [platform.cpu],
        exports: { "./helper": `./runtime/${platform.helper}` },
        files: ["runtime", "LICENSE"],
      },
      (stage) => {
        const archive = path.join(assets, `baasx-${version}-${platform.asset}-bun.tgz`);
        const members = [platform.helper, platform.legacyHelper].map(
          (name) => `package/runtime/${name}`
        );
        const entries = execFileSync(tar, ["-tzf", archive], { encoding: "utf8" }).split(/\r?\n/);
        for (const member of members) {
          if (!entries.includes(member)) throw new Error(`${platform.asset} missing ${member}`);
        }
        execFileSync(tar, ["-xzf", archive, "-C", stage, "--strip-components=1", ...members]);
        for (const name of [platform.helper, platform.legacyHelper])
          chmodSync(path.join(stage, "runtime", name), 0o755);
      }
    );
  }
  const binManifest = { bin: { baasx: "bin/baasx.mjs" }, engines: { node: ">=20.3.0" } };
  pack(
    {
      name: "@kiramei/baasx",
      description,
      ...binManifest,
      exports: { "./cli": "./bin/baasx.mjs" },
      optionalDependencies: Object.fromEntries(platforms.map((p) => [p.name, version])),
      files: ["bin", "dist", "README.md", "README_zh.md", "LICENSE"],
    },
    (stage) => {
      bin(stage, "baasx.mjs");
      mkdirSync(path.join(stage, "dist"));
      copyFileSync(path.resolve(values.bundle), path.join(stage, "dist/baasx-node.mjs"));
      for (const file of ["README.md", "README_zh.md"])
        copyFileSync(path.join(project, file), path.join(stage, file));
    }
  );
  pack(
    {
      name: "baasx",
      description,
      ...binManifest,
      dependencies: { "@kiramei/baasx": version },
      files: ["bin", "LICENSE"],
    },
    (stage) => bin(stage, "alias.mjs")
  );
  console.log(JSON.stringify(packages));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
