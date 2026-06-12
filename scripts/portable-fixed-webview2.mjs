import fs from "fs";
import fsp from "fs/promises";
import path from "path";

import { context, getOctokit } from "@actions/github";
import AdmZip from "adm-zip";

const target = process.argv.slice(2)[0];

const ARCH_MAP = {
  "x86_64-pc-windows-msvc": "x64",
  "aarch64-pc-windows-msvc": "arm64",
  "i686-pc-windows-msvc": "x86",
};

const PROCESS_MAP = {
  x64: "x64",
  arm64: "arm64",
  ia32: "x86",
};

const arch = target ? ARCH_MAP[target] : PROCESS_MAP[process.arch];

if (!arch) {
  throw new Error(`Unsupported target or architecture: ${target || process.arch}`);
}

async function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(await fsp.readFile(file, "utf-8"));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function resolveReleaseDir() {
  const candidates = target
    ? [
        path.join(process.cwd(), "target", target, "release"),
        path.join(process.cwd(), "src-tauri", "target", target, "release"),
      ]
    : [
        path.join(process.cwd(), "target", "release"),
        path.join(process.cwd(), "src-tauri", "target", "release"),
      ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }

  throw new Error(`Could not find release dir. Checked: ${candidates.join(", ")}`);
}

async function resolveMainExe(releaseDir) {
  const packageJson = await readJsonIfExists(path.join(process.cwd(), "package.json"));
  const tauriConf = await readJsonIfExists(
    path.join(process.cwd(), "src-tauri", "tauri.conf.json")
  );

  const productName = tauriConf?.productName || "BAAS Tauri";
  const packageName = packageJson?.name;

  const candidates = unique([
    `${productName}.exe`,
    `${productName.replace(/\s+/g, ".")}.exe`,
    packageName ? `${packageName}.exe` : null,
    "BAAS Tauri.exe",
    "BAAS.Tauri.exe",
    "baas-tauri.exe",
  ]);

  for (const name of candidates) {
    const file = path.join(releaseDir, name);
    if (fs.existsSync(file)) return file;
  }

  const exeFiles = fs
    .readdirSync(releaseDir)
    .filter((name) => name.toLowerCase().endsWith(".exe"))
    .filter((name) => !name.toLowerCase().includes("mihomo"))
    .filter((name) => !name.toLowerCase().includes("setup"))
    .filter((name) => !name.toLowerCase().includes("unins"));

  if (exeFiles.length === 1) {
    return path.join(releaseDir, exeFiles[0]);
  }

  throw new Error(
    [
      "Could not identify the main application executable.",
      `Release dir: ${releaseDir}`,
      `Expected one of: ${candidates.join(", ")}`,
      `Found exe files: ${exeFiles.join(", ") || "(none)"}`,
    ].join("\n")
  );
}

function addLocalFileIfExists(zip, file, zipPath = "") {
  if (fs.existsSync(file)) {
    zip.addLocalFile(file, zipPath);
    console.log(`[INFO]: added file ${file}`);
  }
}

function addFixedWebView2RuntimeIfExists(zip, releaseDir) {
  const entries = fs.readdirSync(releaseDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!/webview2|microsoft\.webview/i.test(entry.name)) continue;

    const fullPath = path.join(releaseDir, entry.name);

    if (entry.isDirectory()) {
      zip.addLocalFolder(fullPath, entry.name);
      console.log(`[INFO]: added WebView2 runtime folder ${fullPath}`);
    } else if (entry.isFile()) {
      zip.addLocalFile(fullPath);
      console.log(`[INFO]: added WebView2 runtime file ${fullPath}`);
    }
  }
}

async function uploadAssetIfPossible(zipFilePath, zipFileName) {
  const token = process.env.GITHUB_TOKEN;
  const tagName = process.env.GITHUB_REF_NAME || process.env.TAG_NAME;

  if (!token || !tagName) {
    console.log("[INFO]: skip release upload because GITHUB_TOKEN or tag name is missing");
    return;
  }

  const repoFullName =
    process.env.GITHUB_REPOSITORY ||
    (context.repo.owner && context.repo.repo ? `${context.repo.owner}/${context.repo.repo}` : "");

  if (!repoFullName.includes("/")) {
    console.log("[INFO]: skip release upload because repository context is missing");
    return;
  }

  const [owner, repo] = repoFullName.split("/");
  const github = getOctokit(token);

  const { data: release } = await github.rest.repos.getReleaseByTag({
    owner,
    repo,
    tag: tagName,
  });

  for (const asset of release.assets) {
    if (asset.name === zipFileName) {
      console.log(`[INFO]: deleting existing release asset ${zipFileName}`);
      await github.rest.repos.deleteReleaseAsset({
        owner,
        repo,
        asset_id: asset.id,
      });
    }
  }

  await github.rest.repos.uploadReleaseAsset({
    owner,
    repo,
    release_id: release.id,
    name: zipFileName,
    data: await fsp.readFile(zipFilePath),
  });

  console.log(`[INFO]: uploaded portable asset ${zipFileName}`);
}

/// Package fixed WebView2 portable bundle. Windows only.
async function resolvePortable() {
  if (process.platform !== "win32") {
    console.log("[INFO]: skip portable bundle because current platform is not Windows");
    return;
  }

  const releaseDir = await resolveReleaseDir();

  const mainExe = await resolveMainExe(releaseDir);
  const packageJson = await readJsonIfExists(path.join(process.cwd(), "package.json"));
  const version = packageJson?.version;

  if (!version) {
    throw new Error("Could not read version from package.json");
  }

  const zip = new AdmZip();

  // Only include the main application executable.
  addLocalFileIfExists(zip, mainExe);
  addFixedWebView2RuntimeIfExists(zip, releaseDir);

  const zipFileName = `BAAS.Tauri_${version}_${arch}_fixed_webview2_portable.zip`;
  const zipFilePath = path.join(process.cwd(), zipFileName);

  zip.writeZip(zipFilePath);
  console.log(`[INFO]: created portable zip ${zipFilePath}`);

  await uploadAssetIfPossible(zipFilePath, zipFileName);
}

resolvePortable().catch((error) => {
  console.error(error);
  process.exit(1);
});
