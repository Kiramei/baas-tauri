#!/usr/bin/env node
import { existsSync } from "node:fs";

const nodeEntry = new URL("../dist/baasx-node.mjs", import.meta.url);
const bunEntry = new URL("../dist/baasx.js", import.meta.url);
const entry = existsSync(nodeEntry) ? nodeEntry : "Bun" in globalThis ? bunEntry : nodeEntry;
if (!existsSync(entry)) {
  process.stderr.write(
    "baasx 尚未构建 / has not been built. Run bun run baasx:build in the repository root.\n"
  );
  process.exitCode = 1;
} else {
  await import(entry.href);
}
