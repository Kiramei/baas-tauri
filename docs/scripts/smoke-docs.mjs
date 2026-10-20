import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const contentRoutes = (locale) =>
  readdirSync(path.join(root, "docs/content/docs", locale), { recursive: true })
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => file.slice(0, -4).replaceAll("\\", "/"))
    .map((route) => (route === "index" ? "" : route))
    .sort();
const routes = contentRoutes("en");
assert.deepEqual(contentRoutes("zh"), routes, "Localized documentation route sets must match");
const output = path.join(root, ".cache/docs-smoke");
mkdirSync(output, { recursive: true });
const origin = process.argv[2] || "http://127.0.0.1:4173";
const nativeBenchmark = JSON.parse(
  readFileSync(path.join(root, "docs/public/benchmarks/native-transport-current.json"), "utf8")
);
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
        for (const route of routes) {
          const response = await page.goto(`${origin}/docs/${locale}/${route ? route + "/" : ""}`);
          assert.equal(response.status(), 200);
          await page.waitForFunction(
            (dark) => document.documentElement.classList.contains("dark") === dark,
            theme === "dark"
          );
          await page.locator("h1").waitFor();
          await page.waitForFunction(
            () =>
              document.querySelectorAll(".baas-mermaid").length ===
              document.querySelectorAll(".baas-mermaid-content > svg").length
          );
          assert.equal(await page.locator(".baas-mermaid-error").count(), 0);
          const article = await page.locator("body").innerText();
          assert.ok(
            !/本套文档以当前|文档入口优先|This documentation follows the current/.test(article)
          );
          if (route === "reference/client-architecture") {
            await page.waitForFunction(
              () => document.querySelectorAll(".baas-mermaid-content > svg").length === 2
            );
            assert.equal(await page.locator(".baas-mermaid-error").count(), 0);
            for (const diagram of await page.locator(".baas-mermaid").all()) {
              const chart = diagram.locator(".baas-mermaid-content > svg");
              const initialWidth = await chart.evaluate(
                (element) => element.getBoundingClientRect().width
              );
              assert.ok(initialWidth > 0);
              const zoomIn = diagram.getByRole("button", {
                name: locale === "zh" ? "放大图表" : "Zoom in diagram",
                exact: true,
              });
              const zoomOut = diagram.getByRole("button", {
                name: locale === "zh" ? "缩小图表" : "Zoom out diagram",
                exact: true,
              });
              const reset = diagram.getByRole("button", {
                name: locale === "zh" ? "重置图表缩放" : "Reset diagram zoom",
                exact: true,
              });
              assert.ok(await zoomOut.isDisabled());
              assert.ok(await reset.isDisabled());
              await zoomIn.click();
              assert.equal(await diagram.locator("output").innerText(), "150%");
              const zoomedWidth = await chart.evaluate(
                (element) => element.getBoundingClientRect().width
              );
              assert.ok(Math.abs(zoomedWidth / initialWidth - 1.5) < 0.01);
              await zoomOut.click();
              assert.equal(await diagram.locator("output").innerText(), "100%");
              for (let step = 0; step < 14; step++) await zoomIn.click();
              assert.equal(await diagram.locator("output").innerText(), "800%");
              assert.ok(await zoomIn.isDisabled());
              const maxWidth = await chart.evaluate(
                (element) => element.getBoundingClientRect().width
              );
              assert.ok(Math.abs(maxWidth / initialWidth - 8) < 0.01);
              const overflow = await diagram
                .locator(".baas-mermaid-viewport")
                .evaluate((element) => {
                  element.scrollLeft = element.clientWidth;
                  return {
                    internal: element.scrollWidth > element.clientWidth,
                    scroll: element.scrollLeft,
                    page:
                      document.documentElement.scrollWidth >
                      document.documentElement.clientWidth + 1,
                  };
                });
              assert.ok(overflow.internal && overflow.scroll > 0);
              assert.equal(overflow.page, false);
              await reset.click();
              assert.equal(await diagram.locator("output").innerText(), "100%");
              assert.equal(
                await diagram
                  .locator(".baas-mermaid-viewport")
                  .evaluate((element) => element.scrollLeft),
                0
              );
            }
          }
          if (
            route.startsWith("features/") ||
            route === "guide/android" ||
            route === "guide/install" ||
            route === "reference/setup-toml" ||
            route === "reference/performance"
          ) {
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
            for (const selector of [".baas-encoding-benchmark", ".baas-transport-benchmark"]) {
              const chart = page.locator(selector);
              const outputs = await chart.locator("output").allTextContents();
              await chart.getByRole("button", { name: "p95", exact: true }).click();
              assert.notDeepEqual(await chart.locator("output").allTextContents(), outputs);
              await chart.getByRole("button", { name: "p50", exact: true }).click();
              assert.deepEqual(await chart.locator("output").allTextContents(), outputs);
            }
            const nativeChart = page.locator(".baas-transport-benchmark");
            assert.deepEqual(
              await nativeChart.locator("output").allTextContents(),
              nativeBenchmark.results.map((result) => result.p50Ms.toFixed(1) + " ms")
            );
            const tracks = await nativeChart
              .locator(".baas-benchmark-track")
              .evaluateAll((elements) =>
                elements.map((element) => ({
                  track: element.getBoundingClientRect().width,
                  bar: element.firstElementChild.getBoundingClientRect().width,
                }))
              );
            const maximum = Math.max(...nativeBenchmark.results.map((result) => result.p50Ms));
            for (const [index, track] of tracks.entries()) {
              assert.ok(Math.abs(track.track - tracks[0].track) < 1);
              assert.ok(
                Math.abs(
                  track.bar / (track.track - 1) - nativeBenchmark.results[index].p50Ms / maximum
                ) < 0.01
              );
            }
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
              `${locale}-${theme}-${viewport.width}-${route.replaceAll("/", "-") || "index"}.png`
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
