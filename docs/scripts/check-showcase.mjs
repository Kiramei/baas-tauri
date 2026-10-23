import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExportServer } from "./static-export-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "docs/out"), cache = path.join(root, ".cache/dark-showcase/layout");
mkdirSync(cache, { recursive: true });
const assets = JSON.parse(readFileSync(path.join(root, "docs/lib/showcase-assets.json")));
const published = new Set(Object.values(assets));
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const server = createExportServer(out, "");
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.DOCS_BROWSER_CHANNEL || "msedge", headless: true });
const results = [], errors = [];
let staticReferences = 0;
try {
  const parser = await browser.newPage();
  for (const file of readdirSync(out, { recursive: true }).filter(file => file.endsWith("index.html"))) {
    const sources = await parser.evaluate(html => [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("img[src]")].map(img => img.getAttribute("src")), readFileSync(path.join(out, file), "utf8"));
    for (const src of sources.filter(src => src.startsWith("/media/desktop/"))) {
      assert.ok(published.has(src), "A desktop image still uses an old or unreviewed asset: " + file + " -> " + src);
      staticReferences++;
    }
  }
  await parser.close();
  assert.ok(staticReferences > 100);
  for (const locale of ["en", "zh"]) for (const theme of ["light", "dark"]) for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    await context.addInitScript(theme => localStorage.setItem("theme", theme), theme);
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    for (const route of ["guide/interface", "guide/install", "features/system", "features/home-runtime", "guide/configuration"]) {
      const response = await page.goto(`${base}/docs/${locale}/${route}/`, { waitUntil: "networkidle" });
      assert.equal(response.status(), 200);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), theme === "dark");
      const images = page.locator("img[src*='/media/desktop/']");
      assert.ok(await images.count());
      for (const img of await images.all()) {
        assert.ok(published.has(await img.getAttribute("src")));
        await img.scrollIntoViewIfNeeded();
        await page.waitForFunction(img => img.complete && img.naturalWidth > 0, await img.elementHandle());
        const bounds = await img.boundingBox();
        assert.ok(bounds && bounds.width > 0 && bounds.x >= -1 && bounds.x + bounds.width <= (mobile ? 391 : 1441));
      }
      if (route === "guide/configuration") {
        const demo = page.locator(".baas-motion-demo");
        await demo.scrollIntoViewIfNeeded();
        const button = demo.getByRole("button"), img = demo.locator("img");
        await button.click();
        await page.waitForFunction(img => img.complete && img.naturalWidth > 0 && img.src.includes("/dark/") && img.src.endsWith(".animated.webp"), await img.elementHandle());
        await button.click();
        assert.equal(await button.getAttribute("aria-pressed"), "false");
        assert.ok((await img.getAttribute("src")).endsWith("/dark/config-cafe.webp"));
      }
      await images.first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-${route.replace("/", "-")}.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      results.push({ locale, theme, mobile, route, images: await images.count(), passed: true });
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  const sources = ["docs/scripts/check-showcase.mjs", "docs/lib/showcase-media.mjs", "docs/lib/showcase-assets.json", "docs/lib/remark-doc-links.mjs", "docs/components/MotionDemo.tsx", "docs/public/media/desktop/dark-manifest.json", "README.md", "README_zh.md"];
  const report = { checkedAt: new Date().toISOString(), cases: results.length, failures: 0, staticReferences,
    scope: "Static document and browser rendering checks only; no native commands or device operations.",
    testedSources: Object.fromEntries(sources.map(file => [file, createHash("sha256").update(readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n")).digest("hex")])), results };
  writeFileSync(path.join(root, "docs/evidence/showcase-layout.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ cases: report.cases, failures: 0, staticReferences }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
