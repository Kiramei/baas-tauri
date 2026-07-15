import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { stageCppService, repositoryRoot } from "./stage-cpp-service.mjs";

const { destination } = await stageCppService();
const config = join(
  "src-tauri",
  process.platform === "win32"
    ? "tauri.cpp-service.windows.conf.json"
    : "tauri.cpp-service.unix.conf.json"
);
console.log(`Packaging verified C++ service resource ${destination}`);
const result = spawnSync(
  process.execPath,
  ["run", "tauri", "--", "build", "--config", config, ...process.argv.slice(2)],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
    shell: false,
  }
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
