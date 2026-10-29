#!/usr/bin/env bun
import { existsSync } from "node:fs";

const entry = new URL("../dist/baasx.js", import.meta.url);
if (!existsSync(entry)) {
  process.stderr.write("baasx 尚未构建。请在仓库根目录运行 bun run baasx:build。\n");
  process.exitCode = 1;
} else {
  await import(entry.href);
}
