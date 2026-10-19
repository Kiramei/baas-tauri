// Usage: node scripts/build-macos-icons.mjs
// Requires sharp. Renders the exact tray vector and exports macOS icon sizes.
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const sharp = require(process.env.BAAS_SHARP_PATH || "sharp");
const root = fileURLToPath(new URL("../", import.meta.url));
const icons = path.join(root, "src-tauri/icons");
const tray = await readFile(path.join(icons, "tray-macos.svg"));
await sharp(tray, { density: 288 }).resize(44, 44).png().toFile(path.join(icons, "tray-macos.png"));
await writeFile(path.join(icons, "tray-macos.rgba"), await sharp(tray, { density: 288 }).resize(44, 44).ensureAlpha().raw().toBuffer());

const iconset = path.join(icons, "macos/app.iconset");
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    await sharp(path.join(icons, "macos/app-icon.png"))
      .resize(size * scale, size * scale)
      .png()
      .toFile(path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`));
  }
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(icons, "macos/icon.icns")]);
console.log("Exported macOS app icon and transparent tray template.");
