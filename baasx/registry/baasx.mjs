#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
if (!process.env.BAASX_RUNTIME_HELPER && !process.env.BAAS_RUNTIME_HELPER) {
  const cpu = ["armv7l", "armhf"].includes(process.arch) ? "arm" : process.arch;
  const name = `@kiramei/baasx-${process.platform}-${cpu}`;
  try {
    process.env.BAASX_RUNTIME_HELPER = require.resolve(`${name}/helper`);
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    // Remote/demo commands do not use a native helper. Local commands use the
    // existing missing-helper error if optional dependencies were omitted.
  }
}
await import("../dist/baasx-node.mjs");
