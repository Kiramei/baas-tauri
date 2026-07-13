import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "android-build-debug.mjs");
const result = spawnSync("bun", [script, "--profile", "release", ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
  shell: false,
  windowsHide: true,
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
