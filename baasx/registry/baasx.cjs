#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { existsSync } = require("node:fs");
const { constants } = require("node:os");

const executable = process.platform === "win32" ? "baasx.exe" : "baasx";
const platform = `${process.platform}-${process.arch}`;
const program = join(__dirname, "..", "platforms", platform, executable);
if (!existsSync(program)) {
  console.error(
    `BAASX does not provide a native build for ${platform}. Supported platforms: darwin-arm64, linux-x64, win32-x64.`
  );
  process.exitCode = 1;
} else {
  const child = spawn(program, process.argv.slice(2), { stdio: "inherit", windowsHide: false });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  child.once("error", (error) => {
    console.error(`Unable to start BAASX: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? 128 + (constants.signals[signal] || 0);
  });
}
