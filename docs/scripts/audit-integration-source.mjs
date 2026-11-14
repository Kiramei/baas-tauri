import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reportPath = path.join(root, "docs/evidence/updater-source-audit.json");
const audit = JSON.parse(readFileSync(reportPath, "utf8"));
const canonical = (value) => value.toString().replaceAll("\r\n", "\n");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const files = [...new Set([
  ...audit.mirrorCredentialSupplement.sources.map(({ file }) => file),
  ...audit.historySupplement.sources.map(({ file }) => file),
  "crates/baas-updater/src/environ.rs",
  "src-tauri/src/platform/windows/client_update.rs",
  "src-tauri/src/platform/windows/portable_transaction.rs",
  "src/shared/ClientUpdateRestart.ts",
  "src/shared/ProfileArchiveImport.ts",
  "src/shared/ProfileFolderImport.ts",
  "src/context/TauriSelfUpdateProvider.tsx",
  "src/components/IdleBackendUpdater.tsx",
  "src/components/layout/Sidebar.tsx",
  "src/shared/AndroidStartupUpdate.ts",
  "src/shared/AndroidBackendUpdate.ts",
  "src/android/StartupBackendUpdate.ts",
  "src/android/useAndroidResourcesReady.ts",
  "src/store/WebsocketStore.ts",
  "src-tauri/gen/android/app/src/main/python/android_backend/bootstrap.py",
  "src-tauri/gen/android/app/src/main/python/android_backend/resource_readiness.py",
  "src-tauri/gen/android/app/src/main/python/android_backend/profile_resources.py",
  "src-tauri/gen/android/app/src/main/python/android_backend/ocr_runtime_cache.py",
  "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/NativeGameText.kt",
  "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/NativeGamePreview.kt",
  "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/NativeGameFullscreen.kt",
])];
const sources = files.map((file) => {
  const pinned = canonical(execFileSync("git", ["show", `${revision}:${file}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 }));
  assert.equal(canonical(readFileSync(path.join(root, file))), pinned, `${file} has uncommitted source changes`);
  return { file, revision, sha256: sha(pinned), gitContentVerified: true };
});
const pages = ["en", "zh"].flatMap((locale) => [
  "reference/updater-internals", "features/update", "reference/client-architecture", "reference/setup-toml",
  "android/install", "guide/android",
].map((route) => `docs/content/docs/${locale}/${route}.mdx`));
// Preserve prior audits as historical evidence; supersede only the inspected pages.
audit.integrationSupplement = {
  checkedAt: new Date().toISOString(),
  verificationKind: "code inspection and pinned Git-content comparison; no credential file read",
  runtimeUpdateExecuted: false,
  scope: [
    "native device-local CDK validation and private storage",
    "stable archive selection and Android Git fallback",
    "managed UV cache cleanup after successful dependency setup, with ownership and symlink guards",
    "Windows portable client payload verification, replacement, startup acknowledgement and rollback",
    "localized backend history presentation and unchanged metadata-only retrieval",
    "Android verified OCR/static resources, startup update checking, real restart and fresh readiness cycle",
    "shared ZIP/folder import preflight, fresh user-profile IDs and reserved unique destination names",
    "isolated profile-initialization errors, recoverable owned OCR caches and seven-language native game labels",
  ],
  sources,
  testedPages: Object.fromEntries(pages.map((file) => [file, sha(canonical(readFileSync(path.join(root, file))))])),
  limitations: [
    "Source inspection and offline tests do not establish a successful Windows portable installation or recovery on real hardware.",
    "No runtime updater, network CDK validation, native window, device operation or private credential access was performed.",
  ],
};
writeFileSync(reportPath, JSON.stringify(audit, null, 2) + "\n");
console.log(JSON.stringify({ sources: sources.length, pages: pages.length, revision, runtimeUpdateExecuted: false }));
