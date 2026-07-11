import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const assetsDir = path.join(root, "dist", "assets");
const forbiddenFilePatterns = [/TauriSharedMemoryTransport/i, /tauri-shm/i, /backend-ipc/i];
const forbiddenContent = [
  "@tauri-apps/api",
  "backend_ipc_start",
  "backend_ipc_open_channel",
  "backend_ipc_send_json",
  "backend_ipc_send_bytes",
  "backend_ipc_subscribe",
  "shared-memory backend",
  "TauriSharedMemoryTransport",
];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = await walk(assetsDir);
const badNames = files
  .map((file) => path.relative(root, file))
  .filter((file) => forbiddenFilePatterns.some((pattern) => pattern.test(file)));

if (badNames.length > 0) {
  throw new Error(`WebUI build emitted forbidden Tauri/shared-memory chunks:\n${badNames.join("\n")}`);
}

const jsFiles = files.filter((file) => file.endsWith(".js"));
const badContent = [];
for (const file of jsFiles) {
  const content = await readFile(file, "utf8");
  for (const needle of forbiddenContent) {
    if (content.includes(needle)) {
      badContent.push(`${path.relative(root, file)} contains ${needle}`);
    }
  }
}

if (badContent.length > 0) {
  throw new Error(`WebUI build contains forbidden Tauri/shared-memory code:\n${badContent.join("\n")}`);
}

console.log("webui transport build check passed");
