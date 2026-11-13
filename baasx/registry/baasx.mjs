#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
if (!process.env.BAAS_RUNTIME_HELPER) {
  const name = `@kiramei/baasx-${process.platform}-${process.arch}`;
  try {
    process.env.BAAS_RUNTIME_HELPER = require.resolve(`${name}/helper`);
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    // Remote/demo commands do not use a native helper. Local commands use the
    // existing missing-helper error if optional dependencies were omitted.
  }
}
await import("../dist/baasx-node.mjs");
