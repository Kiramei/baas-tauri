/**
 * -----------------------------------------------------------------------------
 * afterBundle.js
 * -----------------------------------------------------------------------------
 *
 * Purpose:
 *   This script is intended to be executed *after* a Tauri build completes.
 *   It automatically compresses the generated application binary using UPX
 *   (Ultimate Packer for eXecutables) to reduce file size.
 *
 * Features:
 *   ✅ Cross-platform support (Windows / macOS / Linux)
 *   ✅ Detects whether UPX is installed before running
 *   ✅ Detects if a binary has already been packed (skips it)
 *   ✅ Skips UPX’s own binary to prevent self-compression
 *   ✅ Never crashes the Tauri build process — always exits gracefully
 *   ✅ Verbose logs for every step
 *
 * Typical use case:
 *   "pnpm tauri build && node scripts/afterBundle.js"
 *
 * -----------------------------------------------------------------------------
 * HOW TO USE:
 * -----------------------------------------------------------------------------
 * 1. Install UPX manually or via package manager:
 *    - Windows: scoop install upx   OR   choco install upx
 *    - macOS:   brew install upx
 *    - Linux:   sudo apt install upx
 *
 * 2. Place this file at:  <project_root>/scripts/afterBundle.js
 *
 * 3. Update your `package.json` scripts section:
 *      {
 *        "scripts": {
 *          "build:tauri": "pnpm tauri build && node scripts/afterBundle.js"
 *        }
 *      }
 *
 * 4. Run the build:
 *      pnpm run build:tauri
 *
 * 5. The script will locate built binaries inside `src-tauri/target/release`
 *    and compress them using UPX if available.
 *
 * -----------------------------------------------------------------------------
 */

import { execSync, spawnSync } from "child_process";
import { readdirSync, statSync } from "fs";
import { platform } from "os";
import path from "path";

/* -------------------------------------------------------------------------- */
/* Utility Functions                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Check whether UPX exists in the system PATH.
 *
 * @returns {boolean} true if UPX is found, false otherwise.
 */
function hasUPX() {
  const command = platform() === "win32" ? "where" : "which";
  const result = spawnSync(command, ["upx"], { stdio: "ignore" });
  return result.status === 0;
}

/**
 * Resolve the Tauri build output directory.
 * By default, Tauri outputs binaries under `src-tauri/target/release/`.
 *
 * @returns {string} Absolute path to the release directory.
 */
function getTargetDir() {
  return path.resolve("src-tauri/target/release");
}

/**
 * Determine whether the specified file is already packed with UPX.
 *
 * @param {string} file - Path to the binary file.
 * @returns {boolean} true if already packed; false otherwise.
 */
function isAlreadyPacked(file) {
  try {
    const output = execSync(`upx -t "${file}"`, { stdio: "pipe" }).toString();
    // UPX will include the string "already packed" when verifying a packed file
    return output.toLowerCase().includes("already packed");
  } catch {
    // If UPX test fails, assume file is not packed
    return false;
  }
}

/**
 * Compress a single file with UPX if it is not already compressed.
 *
 * @param {string} file - Path to the binary file to compress.
 */
function compressFile(file) {
  try {
    const fileName = path.basename(file).toLowerCase();

    // 1️⃣ Skip UPX itself to prevent self-compression
    if (fileName.includes("upx")) {
      console.log(`[UPX] ⏩ Skipping UPX binary itself: ${file}`);
      return;
    }

    // 2️⃣ Skip directories (safety check)
    if (statSync(file).isDirectory()) {
      console.log(`[UPX] ⏩ Skipping directory: ${file}`);
      return;
    }

    // 3️⃣ Skip files that are already packed
    if (isAlreadyPacked(file)) {
      console.log(`[UPX] ⏩ Skipping already packed file: ${file}`);
      return;
    }

    // 4️⃣ Run UPX compression
    console.log(`[UPX] 🧩 Compressing ${file}`);
    execSync(`upx --best --lzma "${file}"`, { stdio: "inherit" });
  } catch (err) {
    // Non-fatal: print warning but continue
    console.warn(`[UPX] ⚠️  Failed to compress ${file}: ${err.message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Main Logic                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Main entry point of the UPX post-build script.
 */
function main() {
  console.log("───────────────────────────────────────────────");
  console.log("🔧  UPX Post-Build Compression Script Started");
  console.log("───────────────────────────────────────────────");

  // Check UPX availability
  if (!hasUPX()) {
    console.warn("[UPX] ⚠️  UPX not found in PATH. Skipping compression.");
    console.log("───────────────────────────────────────────────");
    return;
  }

  const dir = getTargetDir();

  // Find all binary files that are likely to be executable
  const files = readdirSync(dir)
    .filter((f) => /\.(exe|appimage|bin)$/i.test(f))
    .map((f) => path.join(dir, f));

  if (files.length === 0) {
    console.log("[UPX] ℹ️  No executable files found to compress.");
    console.log("───────────────────────────────────────────────");
    return;
  }

  // Compress each binary file
  for (const file of files) {
    compressFile(file);
  }

  console.log("───────────────────────────────────────────────");
  console.log("[UPX] ✅ Compression process finished.");
  console.log("───────────────────────────────────────────────");
}

// Execute script
main();
