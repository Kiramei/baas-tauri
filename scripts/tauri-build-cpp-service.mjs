import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repositoryRoot, stageCppServiceResources } from "./stage-cpp-service.mjs";

const { executable, remoteJar } = await stageCppServiceResources();
const config = join(
  "src-tauri",
  process.platform === "win32"
    ? "tauri.cpp-service.windows.conf.json"
    : "tauri.cpp-service.unix.conf.json"
);
console.log(
  `Packaging verified C++ service resources ${executable.destination} and ${remoteJar.destination}`
);
const result = spawnSync(
  process.execPath,
  ["run", "tauri", "--", "build", "--config", config, ...process.argv.slice(2)],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, VITE_BAAS_BACKEND_RUNTIME: "cpp" },
  }
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
