import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const guardedCommands = [
  ["scripts/android-build-release.mjs"],
  ["run", "tauri:android:build", "--", "--release"],
];

for (const args of guardedCommands) {
  const result = spawnSync("bun", args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status === 0) {
    throw new Error(`Android release guard did not fail release command: bun ${args.join(" ")}`);
  }
  if (!output.includes("Android release builds are blocked by the BAAS shared-memory transport refactor.")) {
    throw new Error(`Android release guard failed for an unexpected reason:\n${output}`);
  }
}

const releaseWorkflow = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
if (!releaseWorkflow.includes("bun run tauri:android:build:release")) {
  throw new Error("Android release workflow no longer calls the guarded release build script.");
}
if (/tauri\s+android\s+build[^\n]*--release/.test(releaseWorkflow)) {
  throw new Error("Android release workflow bypasses the shared-memory release guard.");
}

console.log("android shared-memory release guard check passed");
