import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = process.argv[2] || "http://127.0.0.1:4173";
const cache = path.join(root, ".cache/android-docs");
mkdirSync(cache, { recursive: true });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const read = file => readFileSync(path.join(root, file));
const media = JSON.parse(read("docs/evidence/android-native-media.json"));
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [], diagnostics = [], searches = [], pipelines = [];
try {
  for (const locale of ["zh", "en"]) for (const theme of ["light", "dark"]) for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 } });
    await context.addInitScript(theme => localStorage.setItem("theme", theme), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    const failure = locale === "zh" ? "游戏跳回主屏或预览停在启动图" : "Game Returns to the Main Display or Preview Stalls";
    assert.equal((await page.goto(`${base}/docs/${locale}/reference/troubleshooting/`)).status(), 200);
    await page.getByRole("link", { name: locale === "zh" ? "后台游戏排查" : "background-game diagnostics", exact: true }).click();
    await page.waitForURL(url => url.pathname.endsWith(`/docs/${locale}/guide/android/`) && Boolean(url.hash));
    const heading = page.getByRole("heading").filter({ has: page.getByRole("link", { name: failure, exact: true }) });
    await heading.scrollIntoViewIfNeeded();
    assert.ok(await heading.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark, theme === "dark");
    const figure = page.locator(".baas-android-game-demo");
    await figure.scrollIntoViewIfNeeded();
    const image = figure.locator("img");
    await image.evaluate(async el => { await el.decode(); });
    assert.ok((await image.getAttribute("src")).endsWith(`/media/android/${locale}/game-preview.webp`));
    const initial = await image.boundingBox();
    assert.ok(initial && initial.width > 200 && initial.width <= 360.5);
    const style = await image.evaluate(el => ({ radius: getComputedStyle(el).borderRadius, shadow: getComputedStyle(el).boxShadow }));
    assert.equal(style.radius, "8px");
    assert.notEqual(style.shadow, "none");
    const play = figure.getByRole("button", { name: locale === "zh" ? "播放演示" : "Play demonstration", exact: true });
    assert.equal(await play.getAttribute("aria-pressed"), "false");
    await play.click();
    await image.evaluate(async el => { await el.decode(); });
    assert.ok((await image.getAttribute("src")).endsWith(`/media/android/${locale}/game-preview.animated.webp`));
    const frames = [];
    for (let index = 0; index < 3; index++) {
      await page.waitForTimeout(450);
      const screenshot = await image.screenshot();
      const meta = await sharp(screenshot).metadata();
      const region = { left: Math.round(meta.width * 21 / 720), top: Math.round(meta.height * 129 / 1280),
        width: Math.floor(meta.width * 678 / 720), height: Math.floor(meta.height * 381 / 1280) };
      frames.push(await sharp(screenshot).extract(region).removeAlpha().raw().toBuffer());
    }
    assert.equal(new Set(frames.map(hash)).size, 3, "The browser must display changing WebP frames");
    const stop = figure.getByRole("button", { name: locale === "zh" ? "停止演示" : "Stop demonstration", exact: true });
    assert.equal(await stop.getAttribute("aria-pressed"), "true");
    await stop.click();
    await image.evaluate(async el => { await el.decode(); });
    assert.ok((await image.getAttribute("src")).endsWith("game-preview.webp"));
    const final = await image.boundingBox();
    assert.ok(Math.abs(initial.width - final.width) < 1 && Math.abs(initial.height - final.height) < 1);
    await image.click();
    const zoom = page.locator(".baas-image-zoom");
    await zoom.waitFor({ state: "visible" });
    await zoom.locator("img").evaluate(async el => { await el.decode(); });
    await zoom.getByRole("button", { name: locale === "zh" ? "关闭图片预览" : "Close image preview", exact: true }).click();
    await zoom.waitFor({ state: "detached" });
    await image.click();
    await zoom.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await zoom.waitFor({ state: "detached" });
    await page.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-preview.png`) });
    const controls = page.locator(`img[src$='/media/android/${locale}/game-controls.webp']`);
    await controls.scrollIntoViewIfNeeded();
    await controls.evaluate(async el => { await el.decode(); });
    assert.equal(await controls.evaluate(el => el.naturalWidth), 720);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
    results.push({ locale, theme, mobile, nativePosterLoaded: true, nativeControlsLoaded: true,
      motionFramesDiffer: true, playbackStops: true, stableDimensions: true, roundedAndShadowed: true,
      imageZoomOpenClose: true,
      pageErrors: errors, passed: true });
    diagnostics.push({ locale, theme, mobile, linkNavigated: true, headingFits: true, pageErrors: errors, passed: true });
    await page.getByRole("link", { name: locale === "zh" ? "原生预览链路" : "native preview pipeline", exact: true }).click();
    await page.waitForURL(url => url.pathname.endsWith(`/docs/${locale}/reference/client-architecture/`) && Boolean(url.hash));
    const pipeline = page.locator(".baas-mermaid").filter({ hasText: "AImageReader / AHardwareBuffer" });
    await pipeline.locator(".baas-mermaid-content > svg").waitFor({ state: "visible" });
    await pipeline.scrollIntoViewIfNeeded();
    assert.equal(await pipeline.locator("svg .node").count(), 9);
    assert.equal(await page.locator(".baas-mermaid-error").count(), 0);
    const content = pipeline.locator(".baas-mermaid-content");
    const normalWidth = (await content.boundingBox()).width;
    await pipeline.getByRole("button", { name: locale === "zh" ? "放大图表" : "Zoom in diagram", exact: true }).click();
    assert.equal(await pipeline.locator("output").textContent(), "150%");
    assert.ok(Math.abs((await content.boundingBox()).width / normalWidth - 1.5) < 0.02);
    await pipeline.getByRole("button", { name: locale === "zh" ? "重置图表缩放" : "Reset diagram zoom", exact: true }).click();
    assert.equal(await pipeline.locator("output").textContent(), "100%");
    const viewport = pipeline.locator(".baas-mermaid-viewport");
    const lastNode = pipeline.locator("svg .node").filter({ hasText: locale === "zh" ? "脚本截图与识别" : "Script capture and recognition" });
    await lastNode.scrollIntoViewIfNeeded();
    const visibleArea = await viewport.boundingBox(), lastBounds = await lastNode.boundingBox();
    assert.ok(lastBounds.y >= visibleArea.y - 1 && lastBounds.y + lastBounds.height <= visibleArea.y + visibleArea.height + 1);
    await viewport.evaluate(el => el.scrollTo({ left: 0, top: 0 }));
    for (const counter of ["capturedFrames", "presentedFrames", "displayedFrames"])
      assert.equal(await page.locator("table").getByText(counter, { exact: true }).count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
    await pipeline.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-pipeline.png`) });
    pipelines.push({ locale, theme, mobile, sourceLinkNavigated: true, nodes: 9,
      zoomAndReset: true, lastNodeReachable: true, allCountersPresent: true, noPageOverflow: true, pageErrors: [...errors], passed: true });
    await context.close();
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const locale of ["zh", "en"]) {
    await page.goto(`${base}/docs/${locale}/`);
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    const query = locale === "zh" ? "画面未更新" : "No frame updates";
    await dialog.locator("input").fill(query);
    const result = dialog.getByRole("button").filter({ has: page.getByText(locale === "zh" ? "Android 客户端" : "Android Client", { exact: true }) }).first();
    await result.waitFor({ state: "visible" });
    await result.click();
    await page.waitForURL(url => url.pathname.endsWith(`/docs/${locale}/guide/android/`));
    searches.push({ locale, query, foundAndroidGuide: true });
  }
  await context.close();
} finally { await browser.close(); }

const files = ["docs/content/docs/zh/guide/android.mdx", "docs/content/docs/zh/reference/troubleshooting.mdx",
  "docs/content/docs/en/guide/android.mdx", "docs/content/docs/en/reference/troubleshooting.mdx"];
const sources = Object.fromEntries(files.map(file => [file, hash(read(file).toString().replaceAll("\r\n", "\n"))]));
const checkedAt = new Date().toISOString();
writeFileSync(path.join(root, "docs/evidence/android-diagnostics-layout.json"), JSON.stringify({ checkedAt, cases: diagnostics.length,
  failures: 0, testedSources: sources, results: diagnostics }, null, 2) + "\n");
for (const file of ["docs/components/AndroidGameDemo.tsx", "docs/components/ImageZoom.tsx", "docs/app/global.css", "docs/mdx-components.tsx"])
  sources[file] = hash(read(file).toString().replaceAll("\r\n", "\n"));
writeFileSync(path.join(root, "docs/evidence/android-native-layout.json"), JSON.stringify({ checkedAt, cases: results.length,
  failures: 0, mediaManifestSha256: hash(read("docs/evidence/android-native-media.json")),
  sourceRevision: media.sourceRevision, testedSources: sources, results, searches }, null, 2) + "\n");
const pipelineSources = ["docs/scripts/check-android-docs.mjs", "docs/components/Mermaid.tsx", "docs/mdx-components.tsx", "docs/app/global.css",
  ...["zh", "en"].flatMap(locale => [`docs/content/docs/${locale}/guide/android.mdx`, `docs/content/docs/${locale}/reference/client-architecture.mdx`])];
writeFileSync(path.join(root, "docs/evidence/android-preview-layout.json"), JSON.stringify({ checkedAt, cases: pipelines.length,
  scope: "Documentation navigation, diagram rendering and zoom; no emulator or native preview operated",
  failures: 0, testedSources: Object.fromEntries(pipelineSources.map(file => [file, hash(read(file).toString().replaceAll("\r\n", "\n"))])),
  results: pipelines }, null, 2) + "\n");
console.log(JSON.stringify({ renderCases: results.length, diagnosticCases: diagnostics.length, pipelineCases: pipelines.length, searchCases: searches.length, failures: 0 }));
