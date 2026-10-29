#!/usr/bin/env bun
import { existsSync } from "node:fs";

const entry = new URL("../dist/baas.js", import.meta.url);
if (!existsSync(entry)) {
  process.stderr.write("BAAS CLI 尚未构建。请在仓库根目录运行 bun run cli:build。\n");
  process.exitCode = 1;
} else {
  await import(entry.href);
}
