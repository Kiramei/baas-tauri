import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const srcRoot = path.join(root, "src");
const allowedLegacyFiles = new Set([
  path.join(srcRoot, "store", "BackendStore.ts"),
  path.join(srcRoot, "store", "WebsocketStore.ts"),
]);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

const violations = [];
for (const file of await walk(srcRoot)) {
  if (allowedLegacyFiles.has(file)) continue;
  const content = await readFile(file, "utf8");
  if (content.includes("@/store/WebsocketStore")) {
    violations.push(`${path.relative(root, file)} imports WebsocketStore directly`);
  }
  if (/\buseWebSocketStore\b/.test(content)) {
    violations.push(`${path.relative(root, file)} uses legacy useWebSocketStore name`);
  }
}

const legacyStore = path.join(srcRoot, "store", "WebsocketStore.ts");
const legacyStoreContent = await readFile(legacyStore, "utf8");
for (const typeName of ["WebSocketState", "WsCallBackDict", "WsMessageItem", "WsName"]) {
  if (new RegExp(`\\b${typeName}\\b`).test(legacyStoreContent)) {
    violations.push(
      `${path.relative(root, legacyStore)} uses legacy transport type name ${typeName}`
    );
  }
}

if (violations.length > 0) {
  throw new Error(`Backend store import check failed:\n${violations.join("\n")}`);
}

console.log("backend store import check passed");
