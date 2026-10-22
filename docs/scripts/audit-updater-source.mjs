import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha = value => createHash("sha256").update(value).digest("hex");
const canonical = value => value.toString().replaceAll("\r\n", "\n");
const groups = [
  { name: "desktop", repository: "Kiramei/baas-tauri", revision: "be186c524ab9f7a91c41582aec3a5fef06614751", root,
    files: ["crates/baas-updater/src/app.rs", "crates/baas-updater/src/workflow.rs", "crates/baas-updater/src/environ.rs",
      "crates/baas-updater/src/repo.rs", "crates/baas-updater/src/mirrorc.rs", "crates/baas-updater/src/constants.rs",
      "src-tauri/src/commands.rs", "src-tauri/src/lib.rs"] },
  { name: "android", repository: "Kiramei/baas-tauri", revision: "e3ed51d7339ea33dc5b6a397e1368b0dfee48e19",
    root: process.argv[2] || path.resolve(root, "../baas-docs-android-validation"),
    files: ["crates/baas-updater/src/android.rs", "src/components/layout/Sidebar.tsx", "src-tauri/src/mobile_commands.rs",
      "src-tauri/gen/android/app/src/main/python/android_backend/bootstrap.py", "src/components/IdleBackendUpdater.tsx",
      "src/shared/IdleUpdateState.ts", "src/context/TauriSelfUpdateProvider.tsx"] },
  { name: "android-preview", repository: "Kiramei/baas-tauri", revision: "36f08fd35535dccf80b4c51c56da8d33b4201823",
    root: process.argv[2] || path.resolve(root, "../baas-docs-android-validation"),
    files: ["src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/BackendServicePlugin.kt",
      "src-tauri/gen/android/app/src/main/cpp/display_capture.cpp",
      "src-tauri/gen/android/app/src/main/cpp/frame_content.h",
      "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/PreviewFrameProgress.kt",
      "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/NativeGamePreview.kt",
      "src-tauri/gen/android/app/src/main/python/android_backend/native_device.py"] },
  { name: "backend", repository: "Kiramei/baas-dev", revision: "d0a86a089068766ff53682b501b90bee99857a71",
    root: process.argv[3] || path.resolve(root, "../baas-dev"), files: ["service/conf/manager.py"] },
];
const sources = [];
for (const group of groups) for (const file of group.files) {
  const pinned = canonical(execFileSync("git", ["show", `${group.revision}:${file}`],
    { cwd: group.root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }));
  const current = canonical(readFileSync(path.join(group.root, file)));
  assert.equal(current, pinned, `${group.name}/${file} differs from its documented revision`);
  sources.push({ scope: group.name, repository: group.repository, revision: group.revision, file,
    sha256: sha(pinned), lines: pinned.split("\n").length, gitContentVerified: true });
}
const pages = ["zh", "en"].flatMap(locale => ["reference/updater-internals", "features/update", "reference/client-architecture"]
  .map(route => `docs/content/docs/${locale}/${route}.mdx`));
const references = [];
for (const page of pages) {
  const source = canonical(readFileSync(path.join(root, page)));
  for (const match of source.matchAll(/https:\/\/github\.com\/[^\s)]+\/blob\/[^\s)]+/g)) {
    const url = new URL(match[0]);
    const parts = url.pathname.split("/").filter(Boolean);
    const repository = parts.slice(0, 2).join("/"), revision = parts[3], file = parts.slice(4).join("/");
    const row = sources.find(item => item.repository === repository && item.revision === revision && item.file === file);
    assert.ok(row, `Unverified source reference in ${page}: ${url.href}`);
    const lines = /^#L(\d+)(?:-L(\d+))?$/.exec(url.hash);
    assert.ok(lines, `A source reference needs a line anchor: ${url.href}`);
    const start = Number(lines[1]), end = Number(lines[2] || lines[1]);
    assert.ok(start > 0 && end >= start && end <= row.lines, `Invalid source line range: ${url.href}`);
    references.push({ page, url: url.href, scope: row.scope, startLine: start, endLine: end });
  }
}
assert.ok(references.length >= 40);
const report = { checkedAt: new Date().toISOString(), verificationKind: "code inspection and pinned Git-content comparison",
  runtimeUpdateExecuted: false, sources, sourceReferences: references,
  testedPages: Object.fromEntries(pages.map(file => [file, sha(canonical(readFileSync(path.join(root, file))))])),
  inspectedBehavior: ["manual-stop ordering", "idle stop and recovery", "detached backend ownership", "source ranking and SHA projection",
    "desktop Git ancestry guard", "Android certificate callback and hard reset", "MirrorC archive integrity checks",
    "Android deferred service restart and APK-matched service overlay", "APK signature verification and installer handoff", "non-atomic replacement and cancellation limitations",
    "architecture preview/capture branches and three-stage progress checks at the measured APK revision"],
  limitations: ["No updater was executed against the shared workspaces or device", "Source comparison does not establish successful runtime recovery"] };
writeFileSync(path.join(root, "docs/evidence/updater-source-audit.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ sourceFiles: sources.length, references: references.length, pages: pages.length, runtimeUpdateExecuted: false }));
