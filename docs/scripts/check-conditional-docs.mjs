import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = process.argv[2] || "http://127.0.0.1:4173";
const cache = path.join(root, ".cache/docs-conditional-layout");
mkdirSync(cache, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
const errors = [];
try {
  for (const locale of ["en", "zh"]) {
    for (const theme of ["light", "dark"]) {
      for (const mobile of [false, true]) {
        for (const name of ["cafe", "crafting", "lesson", "sweeps", "stages", "team", "android"]) {
          const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
          page.on("pageerror", (error) => errors.push(error.message));
          await page.addInitScript((theme) => localStorage.setItem("theme", theme), theme);
          const url = `${base}/docs/${locale}/${name === "android" ? "guide" : "features"}/${name}/`;
          const response = await page.goto(url, { waitUntil: "networkidle" });
          assert.equal(response.status(), 200, url);
          await page.evaluate(() => document.fonts.ready);
          assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), theme === "dark");
          const images = page.locator("img[src*='conditional-']");
          assert.ok(await images.count(), "No conditional images: " + url);
          for (const img of await images.all()) {
            await img.scrollIntoViewIfNeeded();
            await page.waitForFunction((img) => img.complete && img.naturalWidth > 0, await img.elementHandle());
            const info = await img.evaluate((img) => {
              const box = img.getBoundingClientRect();
              const style = getComputedStyle(img);
              return { x: box.x, right: box.right, width: box.width, radius: parseFloat(style.borderTopLeftRadius), shadow: style.boxShadow };
            });
            assert.ok(info.x >= -1 && info.right <= (mobile ? 391 : 1441) && info.width > 0);
            assert.ok(info.radius > 0 && info.shadow !== "none");
          }
          let animation;
          if (name === "crafting") {
            const demo = page.locator(".baas-motion-demo");
            await demo.scrollIntoViewIfNeeded();
            const image = demo.locator("img");
            assert.ok((await image.getAttribute("src")).endsWith("conditional-craft-priority-still.webp"));
            const before = await image.boundingBox();
            await demo.getByRole("button").click();
            await page.waitForFunction((img) => img.complete && img.naturalWidth > 0 && img.src.endsWith(".animated.webp"), await image.elementHandle());
            assert.equal(await demo.getByRole("button").getAttribute("aria-pressed"), "true");
            const after = await image.boundingBox();
            assert.ok(Math.abs(before.width - after.width) < 1 && Math.abs(before.height - after.height) < 1, "Animation changed image dimensions");
            await page.waitForTimeout(800);
            await page.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-playing.png`) });
            await demo.getByRole("button").click();
            assert.equal(await demo.getByRole("button").getAttribute("aria-pressed"), "false");
            assert.ok((await image.getAttribute("src")).endsWith("conditional-craft-priority-still.webp"));
            animation = "starts still; play/stop returns to still; dimensions stable";
          } else await images.first().scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-${name}.png`) });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          results.push({ locale, theme, mobile, page: name, images: await images.count(), animation, passed: true });
          await page.close();
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  const digest = (file) => createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
  const report = { checkedAt: new Date().toISOString(), cases: results.length, failed: 0, pageErrors: errors,
    captureManifestSha256: Object.fromEntries(["desktop", "android"].map((platform) => [platform, digest(`docs/public/media/${platform}/conditional-manifest.json`)])),
    results };
  writeFileSync(path.join(root, "docs/evidence/conditional-layout-validation.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ cases: results.length, failed: 0 }));
} finally {
  await browser.close();
}
