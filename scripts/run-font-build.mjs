// scripts/run-font-build.mjs
import { spawn, spawnSync } from "child_process";

const strict = process.env.CI_FONT_BUILD_STRICT === "1";

function skipOrFail(message) {
  if (strict) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

/**
 * Detect a working pyftsubset command across platforms.
 * Returns the first command that works, or exits gracefully if none found.
 */
function detectPyftsubsetCmd() {
  const check = spawnSync("pyftsubset", ["--help"], { shell: true });
  if (check.status === 0) return;
  skipOrFail("pyftsubset not found. Skipping font build.");
}

// Select the available Python command
detectPyftsubsetCmd();

/**
 * Detect a working Python command across platforms.
 * Checks "python", "python3", then "py" (Windows launcher).
 * Returns the first command that works, or exits gracefully if none found.
 */
function detectPythonCmd() {
  const candidates = ["python", "python3", "py"];
  for (const cmd of candidates) {
    const check = spawnSync(cmd, ["--version"], { shell: true });
    if (check.status === 0) return cmd;
  }
  skipOrFail("No working Python command found. Skipping font build.");
}

// Select the available Python command
const pythonCmd = detectPythonCmd();

console.log(`🪶 Using Python command: ${pythonCmd}`);

// Run the font build script
const child = spawn(pythonCmd, ["scripts/font-pipeline.py"], {
  stdio: "inherit",
  shell: true,
});

// Always continue the build even if the font script fails
child.on("exit", (code) => {
  if (code !== 0) {
    if (strict) {
      console.error(`Font build failed (exit code ${code}).`);
      process.exit(code ?? 1);
    }
    console.warn(`Font build failed (exit code ${code}), skipping...`);
  }
  process.exit(0);
});
