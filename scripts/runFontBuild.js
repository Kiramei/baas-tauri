// scripts/runFontBuild.js
import { spawn, spawnSync } from "child_process";

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
  console.warn("⚠️  No working Python command found. Skipping font build.");
  process.exit(0);
}

// Select the available Python command
const pythonCmd = detectPythonCmd();

console.log(`🪶 Using Python command: ${pythonCmd}`);

// Run the font build script
const child = spawn(pythonCmd, ["scripts/font_pipeline.py"], {
  stdio: "inherit",
  shell: true,
});

// Always continue the build even if the font script fails
child.on("exit", (code) => {
  if (code !== 0) {
    console.warn(`⚠️  Font build failed (exit code ${code}), skipping...`);
  }
  process.exit(0);
});
