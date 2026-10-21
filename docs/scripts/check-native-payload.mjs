import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExportServer } from "./static-export-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const basePath = option("--base-path", "");
const channel = option("--channel", "msedge");
const exportDir = path.resolve(option("--export-dir", path.join(root, "docs/out")));
const cache = path.join(root, ".cache/deployment", basePath ? "payload-prefixed" : "payload-root");
mkdirSync(cache, { recursive: true });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const read = (file) => readFileSync(path.join(root, file));
const data = JSON.parse(read("docs/public/benchmarks/native-payload-current.json"));
const files = [
  "docs/components/NativePayloadBenchmark.tsx",
  "docs/content/docs/zh/reference/performance.mdx",
  "docs/content/docs/en/reference/performance.mdx",
  "docs/mdx-components.tsx",
  "docs/app/global.css",
  "docs/scripts/check-native-payload.mjs",
];
const testedSources = Object.fromEntries(
  files.map((file) => [file, digest(read(file).toString().replaceAll("\r\n", "\n"))])
);
const server = createExportServer(exportDir, basePath);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
let browser;
const results = [],
  downloads = [];
try {
  browser = await chromium.launch({ channel, headless: true });
  for (const locale of ["zh", "en"])
    for (const theme of ["light", "dark"])
      for (const mobile of [false, true]) {
        const width = mobile ? 390 : 1440;
        const context = await browser.newContext({
          viewport: { width, height: mobile ? 844 : 960 },
        });
        await context.addInitScript((theme) => localStorage.setItem("theme", theme), theme);
        const page = await context.newPage();
        const errors = [],
          resourceFailures = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        page.on("response", (response) => {
          if (response.url().startsWith(origin) && response.status() >= 400)
            resourceFailures.push({
              url: response.url().slice(origin.length),
              status: response.status(),
            });
        });
        try {
          assert.equal(
            (
              await page.goto(`${origin}${basePath}/docs/${locale}/reference/performance/`)
            ).status(),
            200
          );
          const figure = page.locator(".baas-payload-benchmark");
          await figure.waitFor({ state: "visible" });
          await page.waitForFunction(
            (theme) => document.documentElement.classList.contains("dark") === (theme === "dark"),
            theme
          );
          await page.evaluate(() => document.fonts.ready);
          const group = figure.getByRole("group", {
            name: locale === "zh" ? "快照统计量" : "Snapshot statistic",
            exact: true,
          });
          for (const size of [1024, 65536, 1048576])
            for (const metric of ["p50Ms", "p95Ms"]) {
              await figure.getByRole("combobox").selectOption(String(size));
              const button = group.getByRole("button", {
                name: metric === "p50Ms" ? "p50" : "p95",
                exact: true,
              });
              await button.click();
              assert.equal(await button.getAttribute("aria-pressed"), "true");
              const expected = data.results.filter((row) => row.payloadBytes === size);
              const maximum = Math.max(...expected.map((row) => row[metric]));
              const table = await figure
                .locator("tbody tr")
                .evaluateAll((rows) =>
                  rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent))
                );
              for (const [index, row] of expected.entries()) {
                const label =
                  row.mode === "websocket"
                    ? "WebSocket"
                    : row.mode === "pipe"
                      ? "Pipe"
                      : locale === "zh"
                        ? "共享内存"
                        : "SHM";
                const chartRow = figure.locator(`.baas-benchmark-row[data-mode='${row.mode}']`);
                assert.equal(
                  await chartRow.locator("output").innerText(),
                  row[metric].toFixed(1) + " ms"
                );
                const percent = await chartRow
                  .locator(".baas-benchmark-track > div")
                  .evaluate((element) => Number.parseFloat(element.style.width));
                assert.ok(Math.abs(percent - (row[metric] / maximum) * 100) < 0.0001);
                const fits = await chartRow.evaluate((element) => {
                  const nodes = [...element.children].map((node) => node.getBoundingClientRect());
                  return (
                    nodes.every(
                      (node, index) => !index || node.left >= nodes[index - 1].right - 1
                    ) &&
                    [...element.querySelectorAll("span,output")].every(
                      (node) => node.scrollWidth <= node.clientWidth + 1
                    )
                  );
                });
                assert.ok(fits, "Chart labels overlap or overflow");
                assert.deepEqual(table[index], [
                  label,
                  "600",
                  "0",
                  row.blockMeans.meanMs.toFixed(3),
                ]);
              }
              assert.ok(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)
              );
              results.push({
                locale,
                theme,
                mobile,
                payloadBytes: size,
                metric,
                sharedZeroAxis: true,
                valuesMatch: true,
                labelsFit: true,
                tableMatches: true,
                noOverflow: true,
                passed: true,
              });
            }
          await figure.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}.png`),
          });
          const rawLink = page.locator(
            `a[href='${basePath}/benchmarks/native-payload-current.json']`
          );
          assert.equal(await rawLink.count(), 1);
          const navigation = page.waitForNavigation();
          await rawLink.click();
          const response = await navigation;
          assert.equal(response.status(), 200);
          assert.equal(
            digest(await response.body()),
            digest(read("docs/public/benchmarks/native-payload-current.json"))
          );
          assert.deepEqual(errors, []);
          assert.deepEqual(resourceFailures, []);
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
              { locale, theme, mobile, error: error.message, errors, resourceFailures, results },
              null,
              2
            )
          );
          throw error;
        } finally {
          await context.close();
        }
      }
  for (const [file, hash] of Object.entries(testedSources))
    assert.equal(digest(read(file).toString().replaceAll("\r\n", "\n")), hash);
  assert.equal(results.length, 48);
  assert.equal(downloads.length, 8);
  const report = {
    checkedAt: new Date().toISOString(),
    basePath,
    cases: results.length,
    failures: 0,
    dataSha256: digest(read("docs/public/benchmarks/native-payload-current.json")),
    summarySha256: digest(read("docs/public/benchmarks/native-payload-summary.json")),
    exportIndexSha256: digest(
      readFileSync(path.join(exportDir, "docs/en/reference/performance/index.html"))
    ),
    testedSources,
    results,
    downloads,
  };
  writeFileSync(path.join(cache, "results.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(
    path.join(root, "docs/evidence/native-payload-layout.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
  console.log(
    JSON.stringify({ cases: results.length, downloads: downloads.length, basePath, failures: 0 })
  );
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
