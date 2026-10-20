import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, ".cache/docs-smoke");
mkdirSync(output, { recursive: true });
const origin = process.argv[2] || "http://127.0.0.1:4173";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
try {
  for (const test of [
    { language: "zh-CN", expected: "zh", entry: "/" },
    { language: "en-US", expected: "en", entry: "/docs/" },
    { language: "ja-JP", expected: "en", entry: "/" },
    { language: "en-US", preference: "zh", expected: "zh", entry: "/docs/" },
    { language: "zh-CN", preference: "en", expected: "en", entry: "/" },
    { language: "zh-CN", denied: true, expected: "zh", entry: "/" },
  ]) {
    const context = await browser.newContext({ locale: test.language });
    await context.addInitScript(({ preference, denied }) => {
      if (preference) localStorage.setItem("baas-docs-locale", preference);
      if (denied)
        Object.defineProperty(Storage.prototype, "getItem", {
          value() {
            throw new DOMException("Storage disabled", "SecurityError");
          },
        });
    }, test);
    const page = await context.newPage();
    await page.goto(origin + test.entry);
    await page.waitForURL(`**/docs/${test.expected}/`);
    await page.waitForFunction(
      (expected) => document.documentElement.lang === expected,
      test.expected === "zh" ? "zh-CN" : "en"
    );
    assert.equal(await page.locator(".baas-site-home").count(), 0);
    results.push({ kind: "entry-language", ...test, passed: true });
    await context.close();
  }
  for (const locale of ["en", "zh"]) {
    for (const theme of ["light", "dark"]) {
      for (const viewport of [
        { width: 1440, height: 960 },
        { width: 390, height: 844 },
      ]) {
        const context = await browser.newContext({ locale: "en-US", viewport });
        await context.addInitScript((theme) => localStorage.setItem("theme", theme), theme);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        for (const route of [
          "guide/interface",
          "guide/configuration",
          "guide/android",
          "reference/performance",
          "reference/client-architecture",
          "features/cafe",
          "features/lesson",
          "features/shop",
          "features/crafting",
          "features/combat",
          "features/sweeps",
          "features/stages",
          "features/team",
          "features/maintenance",
          "features/server",
          "features/emulator",
          "features/script",
        ]) {
          const response = await page.goto(`${origin}/docs/${locale}/${route}/`);
          assert.equal(response.status(), 200);
          await page.waitForFunction(
            (dark) => document.documentElement.classList.contains("dark") === dark,
            theme === "dark"
          );
          await page.locator("h1").waitFor();
          if (route.startsWith("features/") || route === "guide/android") {
            assert.ok(
              !(await page.locator("body").innerText()).includes("**"),
              `Unparsed strong markup: ${locale}/${route}`
            );
          }
          await page.waitForFunction(() =>
            Array.from(document.querySelectorAll("img.baas-screenshot")).every(
              (image) => image.complete && image.naturalWidth > 0
            )
          );
          const layout = await page.evaluate(() => ({
            width: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            media: Array.from(document.querySelectorAll("img.baas-screenshot")).map((image) => ({
              src: image.getAttribute("src"),
              radius: getComputedStyle(image).borderRadius,
              shadow: getComputedStyle(image).boxShadow,
              width: image.getBoundingClientRect().width,
            })),
          }));
          assert.ok(
            layout.scrollWidth <= layout.width + 1,
            `Overflow: ${locale}/${theme}/${route}/${viewport.width}`
          );
          for (const media of layout.media) {
            assert.equal(media.radius, "8px");
            assert.notEqual(media.shadow, "none");
            assert.ok(media.width <= viewport.width);
          }
          if (route === "reference/performance") {
            const outputs = await page.locator(".baas-benchmark output").allTextContents();
            await page.getByRole("button", { name: "p95", exact: true }).click();
            assert.notDeepEqual(
              await page.locator(".baas-benchmark output").allTextContents(),
              outputs
            );
            await page.getByRole("button", { name: "p50", exact: true }).click();
          }
          if (route === "guide/configuration") {
            await page
              .getByRole("button", {
                name: locale === "zh" ? "播放演示" : "Play demonstration",
                exact: true,
              })
              .click();
            await page.waitForFunction(() =>
              document.querySelector(".baas-motion-demo img")?.getAttribute("src")?.endsWith(".gif")
            );
            await page
              .getByRole("button", {
                name: locale === "zh" ? "停止演示" : "Stop demonstration",
                exact: true,
              })
              .click();
          }
          await page.screenshot({
            path: path.join(
              output,
              `${locale}-${theme}-${viewport.width}-${route.replaceAll("/", "-")}.png`
            ),
          });
          results.push({ kind: "render", locale, theme, viewport, route, passed: true });
        }
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const [locale, query] of [
    ["en", "automatic saving"],
    ["zh", "自动保存"],
  ]) {
    await page.goto(`${origin}/docs/${locale}/`);
    await page.keyboard.press("Control+k");
    const input = page.getByRole("dialog").locator("input");
    await input.fill(query);
    const match = page
      .getByRole("dialog")
      .getByRole("button")
      .filter({
        has: page.getByText(locale === "zh" ? "编辑配置" : "Editing Configuration", {
          exact: true,
        }),
      })
      .first();
    await match.waitFor();
    await match.click();
    await page.waitForURL(`**/docs/${locale}/guide/configuration/**`);
    results.push({ kind: "search-navigation", locale, query, passed: true });
  }
  await page.goto(`${origin}/docs/zh/guide/configuration/`);
  await page.locator(".baas-language-menu summary").click();
  await page
    .locator(".baas-language-menu")
    .getByRole("link", { name: "English", exact: true })
    .click();
  await page.waitForURL("**/docs/en/guide/configuration/**");
  assert.equal(await page.evaluate(() => localStorage.getItem("baas-docs-locale")), "en");
  await page.goto(origin + "/");
  await page.waitForURL("**/docs/en/");
  results.push({ kind: "manual-language-persistence", passed: true });
  await context.close();
  writeFileSync(
    path.join(output, "results.json"),
    `${JSON.stringify({ checkedAt: new Date().toISOString(), origin, results }, null, 2)}\n`
  );
  console.log(JSON.stringify({ passed: results.length, evidence: output }, null, 2));
} finally {
  await browser.close();
}
