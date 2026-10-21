import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createExportServer } from "./static-export-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({
  options: {
    "base-path": { type: "string", default: "" },
    "export-dir": { type: "string", default: "docs/out" },
    channel: { type: "string", default: "msedge" },
  },
});
const basePath = values["base-path"],
  exportDir = path.resolve(root, values["export-dir"]);
const cache = path.join(
  root,
  ".cache/deployment",
  basePath ? "android-local-prefixed" : "android-local-root"
);
mkdirSync(cache, { recursive: true });
const read = (file) => readFileSync(path.join(root, file));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const record = JSON.parse(read("docs/public/benchmarks/android-local-current.json"));
const sources = [
  "docs/components/AndroidLocalBenchmark.tsx",
  "docs/content/docs/zh/reference/performance.mdx",
  "docs/content/docs/en/reference/performance.mdx",
  "docs/mdx-components.tsx",
  "docs/app/global.css",
  "docs/scripts/check-android-local.mjs",
];
const testedSources = Object.fromEntries(
  sources.map((file) => [file, hash(read(file).toString().replaceAll("\r\n", "\n"))])
);
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const server = createExportServer(exportDir, basePath);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const results = [],
  downloads = [];
try {
  browser = await chromium.launch({
    ...(values.channel === "chromium" ? {} : { channel: values.channel }),
    headless: true,
  });
  for (const locale of ["zh", "en"])
    for (const theme of ["light", "dark"])
      for (const mobile of [false, true]) {
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
        });
        await context.addInitScript((theme) => localStorage.setItem("theme", theme), theme);
        const page = await context.newPage();
        const errors = [],
          failures = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        page.on("response", (response) => {
          if (response.url().startsWith(origin + "/") && response.status() >= 400)
            failures.push({ path: response.url().slice(origin.length), status: response.status() });
        });
        try {
          assert.equal(
            (
              await page.goto(`${origin}${basePath}/docs/${locale}/reference/performance/`)
            ).status(),
            200
          );
          await page.waitForFunction(
            (theme) => document.documentElement.classList.contains("dark") === (theme === "dark"),
            theme
          );
          await page.evaluate(() => document.fonts.ready);
          for (const kind of ["capture", "control"]) {
            const figure = page.locator(".baas-android-local-" + kind);
            await figure.waitFor({ state: "visible" });
            const statistics = figure.getByRole("group", {
              name: locale === "zh" ? "本机统计量" : "Local statistic",
              exact: true,
            });
            for (const selection of kind === "capture"
              ? ["static", "animated"]
              : ["api", "confirmed"])
              for (const metric of ["p50Ms", "p95Ms"]) {
                if (kind === "capture") await figure.getByRole("combobox").selectOption(selection);
                else {
                  const group = figure.getByRole("group", {
                    name: locale === "zh" ? "本机计时终点" : "Local timing endpoint",
                    exact: true,
                  });
                  const button = group.getByRole("button", {
                    name:
                      selection === "api"
                        ? locale === "zh"
                          ? "接口返回"
                          : "API return"
                        : locale === "zh"
                          ? "截图确认"
                          : "Screenshot confirmation",
                    exact: true,
                  });
                  await button.click();
                  assert.equal(await button.getAttribute("aria-pressed"), "true");
                }
                const button = statistics.getByRole("button", {
                  name: metric === "p50Ms" ? "p50" : "p95",
                  exact: true,
                });
                await button.click();
                assert.equal(await button.getAttribute("aria-pressed"), "true");
                const expected =
                  kind === "capture"
                    ? record.results.capture
                        .filter((row) => row.scenario === selection)
                        .map((row) => ({
                          key: row.method,
                          value: row[metric],
                          count: row.count,
                          third: String(row.repeatedFrames),
                          fourth: row.maximumTextureMse.toFixed(2),
                        }))
                    : record.results.control.map((row) => ({
                        key: row.scenario,
                        value: row[selection][metric],
                        count: row.api.count,
                        third: row.hold.p50Ms.toFixed(0),
                        fourth: row.travelPixels.p50.toFixed(0),
                      }));
                const labels = {
                  adapter: locale === "zh" ? "底层适配器" : "Adapter",
                  script: locale === "zh" ? "脚本包装" : "Script",
                  click: locale === "zh" ? "点击" : "Click",
                  swipe: locale === "zh" ? "滑动" : "Swipe",
                  long_click: locale === "zh" ? "长按" : "Press",
                };
                const maximum = Math.max(...expected.map((row) => row.value));
                const table = await figure
                  .locator("tbody tr")
                  .evaluateAll((rows) =>
                    rows.map((row) =>
                      [...row.querySelectorAll("td")].map((cell) => cell.textContent)
                    )
                  );
                assert.equal(await figure.locator(".baas-benchmark-row").count(), expected.length);
                for (const [index, row] of expected.entries()) {
                  const chart = figure.locator(`[data-method='${row.key}']`);
                  assert.equal(await chart.locator("span").innerText(), labels[row.key]);
                  assert.equal(
                    await chart.locator("output").innerText(),
                    row.value.toFixed(1) + " ms"
                  );
                  const percent = await chart
                    .locator(".baas-benchmark-track > div")
                    .evaluate((element) => Number.parseFloat(element.style.width));
                  assert.ok(Math.abs(percent - (row.value / maximum) * 100) < 0.0001);
                  assert.ok(
                    await chart.evaluate((element) => {
                      const boxes = [...element.children].map((node) =>
                        node.getBoundingClientRect()
                      );
                      return (
                        boxes.every(
                          (box, index) => !index || box.left >= boxes[index - 1].right - 1
                        ) &&
                        [...element.querySelectorAll("span, output")].every(
                          (node) => node.scrollWidth <= node.clientWidth + 1
                        )
                      );
                    })
                  );
                  assert.deepEqual(table[index], [
                    labels[row.key],
                    row.count + " / 0",
                    row.third,
                    row.fourth,
                  ]);
                }
                assert.ok(
                  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)
                );
                results.push({
                  locale,
                  theme,
                  mobile,
                  kind,
                  selection,
                  metric,
                  valuesMatch: true,
                  sharedZeroAxis: true,
                  labelsFit: true,
                  tableMatches: true,
                  noOverflow: true,
                  passed: true,
                });
              }
            await figure.scrollIntoViewIfNeeded();
            await page.screenshot({
              path: path.join(
                cache,
                `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-${kind}.png`
              ),
            });
          }
          const link = page.locator(`a[href='${basePath}/benchmarks/android-local-current.json']`);
          assert.equal(await link.count(), 1);
          const navigation = page.waitForNavigation();
          await link.click();
          const response = await navigation;
          assert.equal(response.status(), 200);
          assert.equal(
            hash(await response.body()),
            hash(read("docs/public/benchmarks/android-local-current.json"))
          );
          assert.deepEqual(errors, []);
          assert.deepEqual(failures, []);
          downloads.push({
            locale,
            theme,
            mobile,
            nativeNavigation: true,
            rawBytesMatch: true,
            passed: true,
          });
        } catch (error) {
          await page
            .screenshot({
              path: path.join(
                cache,
                `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-failed.png`
              ),
            })
            .catch(() => {});
          writeFileSync(
            path.join(cache, "failure.json"),
            JSON.stringify(
              { locale, theme, mobile, error: error.message, errors, failures, results },
              null,
              2
            )
          );
          throw error;
        } finally {
          await context.close();
        }
      }
  assert.equal(results.length, 64);
  assert.equal(downloads.length, 8);
  for (const [file, digest] of Object.entries(testedSources))
    assert.equal(hash(read(file).toString().replaceAll("\r\n", "\n")), digest);
  const report = {
    checkedAt: new Date().toISOString(),
    basePath,
    cases: 64,
    failures: 0,
    testedSources,
    dataSha256: hash(read("docs/public/benchmarks/android-local-current.json")),
    summarySha256: hash(read("docs/public/benchmarks/android-local-summary.json")),
    exportIndexSha256: hash(
      readFileSync(path.join(exportDir, "docs/en/reference/performance/index.html"))
    ),
    results,
    downloads,
  };
  writeFileSync(path.join(cache, "results.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(
    path.join(root, "docs/evidence/android-local-layout.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
  console.log(JSON.stringify({ cases: 64, downloads: 8, basePath, failures: 0 }));
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
