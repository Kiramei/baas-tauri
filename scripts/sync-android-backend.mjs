import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  ensureInside,
  output,
  parseArgs,
  removeInside,
  repoRoot,
} from "./android-script-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const backendSource =
  args.backendSource ??
  process.env.BAAS_ANDROID_BACKEND_SRC ??
  path.resolve(repoRoot, "..", "baas-dev");
const sourceRoot = path.resolve(backendSource);

if (!fs.existsSync(sourceRoot)) {
  throw new Error(`BAAS Android backend source not found. Set BAAS_ANDROID_BACKEND_SRC or pass --backend-source.`);
}

for (const item of ["main.service.py", "service", "core", "module", "src", "deploy"]) {
  const required = path.join(sourceRoot, item);
  if (!fs.existsSync(required)) {
    throw new Error(`Backend source is missing required item: ${required}`);
  }
}

let backendSha = "";
try {
  backendSha = output("git", ["-C", sourceRoot, "rev-parse", "HEAD"]);
} catch {
  backendSha = "";
}

const pythonRoot = path.join(repoRoot, "src-tauri", "gen", "android", "app", "src", "main", "python");
const destination = path.join(pythonRoot, "baas_backend_bundle");
fs.mkdirSync(path.dirname(destination), { recursive: true });
removeInside(repoRoot, destination, "Android backend bundle");
fs.mkdirSync(destination, { recursive: true });

for (const file of [
  "main.py",
  "main.service.py",
  "pyproject.toml",
  "requirements.txt",
  "requirements-linux.txt",
  "README.md",
  "LICENSE",
]) {
  const source = path.join(sourceRoot, file);
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, path.join(destination, file));
  }
}

const excludedDirs = new Set([
  ".git",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "node_modules",
  "dist",
  "build",
  "tests",
  "docs",
  "output",
]);
const excludedFiles = new Set([".DS_Store"]);
const excludedExts = new Set([".pyc", ".pyo", ".exe", ".dll"]);

function copyFilteredDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
    if (entry.isFile() && excludedFiles.has(entry.name)) continue;
    if (entry.isFile() && excludedExts.has(path.extname(entry.name).toLowerCase())) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyFilteredDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

for (const directory of ["core", "module", "service", "src", "deploy"]) {
  copyFilteredDirectory(path.join(sourceRoot, directory), path.join(destination, directory));
}

const configTarget = path.join(destination, "config");
fs.mkdirSync(configTarget, { recursive: true });
for (const item of ["default_config", "static.json"]) {
  const source = path.join(sourceRoot, "config", item);
  if (!fs.existsSync(source)) continue;
  const target = path.join(configTarget, item);
  const stat = fs.statSync(source);
  if (stat.isDirectory()) copyFilteredDirectory(source, target);
  else fs.copyFileSync(source, target);
}

const androidSetup = `[general]
channel = "dev"
mirrorc_cdk = ""
no_update = false
launch = true
git_backend = "auto"
current_baas_sha = "${backendSha}"

[paths]
baas_root_path = "."

[python]
runtime_path = "embedded-python-3.9"
`;
fs.writeFileSync(path.join(destination, "setup.toml"), androidSetup, "utf8");
fs.writeFileSync(
  path.join(destination, "android-backend-source.json"),
  `${JSON.stringify(
    {
      source: sourceRoot,
      sha: backendSha,
      syncedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const zipPath = path.join(pythonRoot, "android_backend", "baas_backend_bundle.zip");
removeInside(repoRoot, zipPath, "Android backend bundle zip");
fs.mkdirSync(path.dirname(zipPath), { recursive: true });
const zip = new AdmZip();
for (const file of walkFiles(destination)) {
  zip.addLocalFile(file, path.relative(destination, path.dirname(file)).replaceAll("\\", "/"));
}
zip.writeZip(zipPath);
ensureInside(repoRoot, zipPath, "Android backend bundle zip");

console.log(`Synced Android backend to ${destination}`);
console.log(`Packed Android backend zip at ${zipPath}`);

function* walkFiles(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}
