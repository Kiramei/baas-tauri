import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readSearchArtifact } from "./read-search-artifact.mjs";
import { createExportServer } from "./static-export-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { values, positionals } = parseArgs({
  allowPositionals: true, options: { channel: { type: "string", default: "msedge" } },
});
let server;
const base = (positionals[0] || await (async () => {
  server = createExportServer(path.join(root, "docs/out"));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${server.address().port}`;
})()).replace(/\/$/, "");
const cache = path.join(root, ".cache/search-recovery");
mkdirSync(cache, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
let browser;
const results = [];
const labels = (locale) =>
  locale === "zh"
    ? {
        search: "搜索",
        close: "关闭搜索",
        retry: "重新搜索",
        error: "搜索暂时不可用。",
        empty: "未找到结果",
        title: "更新器内部机制",
      }
    : {
        search: "Search",
        close: "Close Search",
        retry: "Retry search",
        error: "Search is temporarily unavailable.",
        empty: "No results found",
        title: "Updater Internals",
      };

try {
  browser = await chromium.launch({ ...(values.channel === "chromium" ? {} : { channel: values.channel }), headless: true });
  for (const locale of ["en", "zh"])
    for (const theme of ["light", "dark"])
      for (const mobile of [false, true]) {
        for (const failure of ["http", "network", "json"]) {
          const context = await browser.newContext({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
          });
          await context.addInitScript((theme) => localStorage.setItem("theme", theme), theme);
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          const text = labels(locale),
            errors = [];
          let requests = 0;
          page.on("pageerror", (error) => errors.push(String(error)));
          await context.route(/\/search-index\/[a-f0-9]{64}\.json$/, async (route) => {
            requests++;
            if (requests > 1) {
              await route.continue();
              return;
            }
            if (failure === "network") await route.abort("failed");
            else
              await route.fulfill({
                status: failure === "http" ? 503 : 200,
                contentType: "application/json",
                body: failure === "json" ? "{" : '{"error":"Unavailable"}',
              });
          });
          try {
            assert.equal((await page.goto(`${base}/docs/${locale}/`)).status(), 200);
            await page.waitForFunction(
              (dark) => document.documentElement.classList.contains("dark") === dark,
              theme === "dark"
            );
            await page.keyboard.press("Control+k");
            let dialog = page.getByRole("dialog", { name: text.search, exact: true });
            await dialog.getByPlaceholder(text.search, { exact: true }).fill("restart_deferred");
            await dialog.getByRole("alert").getByText(text.error, { exact: true }).waitFor();
            assert.equal(requests, 1);
            assert.equal(await dialog.getByText(text.empty, { exact: true }).count(), 0);

            let retryMethod;
            if (failure === "http") {
              await dialog.getByRole("button", { name: text.close, exact: true }).click();
              await page.keyboard.press("Control+k");
              dialog = page.getByRole("dialog", { name: text.search, exact: true });
              await dialog.getByRole("alert").waitFor();
              assert.equal(requests, 1, "Reopening must not start a request loop");
              const retry = dialog.getByRole("button", { name: text.retry, exact: true });
              assert.equal(await retry.getAttribute("title"), text.retry);
              await dialog.evaluate(async (element) => {
                await Promise.all(
                  element.getAnimations({ subtree: true }).map((animation) => animation.finished)
                );
              });
              assert.ok(
                await dialog.evaluate((element) => {
                  const rect = element.getBoundingClientRect();
                  return (
                    rect.left >= 0 &&
                    rect.right <= innerWidth &&
                    rect.top >= 0 &&
                    rect.bottom <= innerHeight
                  );
                })
              );
              await page.screenshot({
                path: path.join(
                  cache,
                  `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-error.png`
                ),
              });
              await retry.click();
              retryMethod = "button-after-reopen";
            } else if (failure === "json") {
              await dialog.getByPlaceholder(text.search, { exact: true }).press("Enter");
              retryMethod = "keyboard";
            } else {
              await dialog.getByPlaceholder(text.search, { exact: true }).fill("restart_deferred ");
              retryMethod = "query-change";
            }

            const result = dialog
              .getByRole("button")
              .filter({ has: page.getByText(text.title, { exact: true }) })
              .first();
            await result.waitFor({ state: "visible" });
            assert.equal(requests, 2, "Retry must perform one fresh index download");
            assert.equal(await dialog.getByRole("alert").count(), 0);
            await dialog
              .getByPlaceholder(text.search, { exact: true })
              .fill("zz_unmatched_recovered_search_49375");
            await dialog.getByText(text.empty, { exact: true }).waitFor();
            assert.equal(requests, 2, "Successful indexes must remain cached");
            await dialog.getByPlaceholder(text.search, { exact: true }).fill("restart_deferred");
            await result.waitFor({ state: "visible" });
            await result.click();
            await page.waitForURL((url) =>
              url.pathname.endsWith(`/docs/${locale}/reference/updater-internals/`)
            );
            await page.getByRole("heading", { name: text.title, exact: true }).waitFor();
            assert.ok(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)
            );
            assert.equal(requests, 2);
            assert.deepEqual(errors, []);
            results.push({
              locale,
              theme,
              mobile,
              failure,
              retryMethod,
              requests,
              navigated: true,
              passed: true,
            });
          } catch (error) {
            await page.screenshot({
              path: path.join(
                cache,
                `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-${failure}-failed.png`
              ),
            });
            console.error(
              JSON.stringify({ locale, theme, mobile, failure, requests, errors, url: page.url() })
            );
            throw error;
          } finally {
            await context.close();
          }
        }
      }
} finally {
  try { if (browser) await browser.close(); }
  finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

const files = [
  "docs/scripts/check-search-recovery.mjs",
  "docs/components/FlexSearchDialog.tsx",
  "docs/lib/search-index.ts",
  "docs/lib/search-encoding.ts",
  "docs/lib/search-contract.ts",
  "docs/lib/search-artifact.server.ts",
  "docs/lib/build-search-index.ts",
  "docs/components/DocsProvider.tsx",
  "docs/app/layout.tsx",
  "docs/app/search-index/[file]/route.ts",
  "docs/scripts/read-search-artifact.mjs",
];
const sha = (file) =>
  createHash("sha256")
    .update(readFileSync(path.join(root, file)).toString().replaceAll("\r\n", "\n"))
    .digest("hex");
writeFileSync(
  path.join(root, "docs/evidence/search-recovery.json"),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      cases: results.length,
      failures: 0,
      testedSources: Object.fromEntries(files.map((file) => [file, sha(file)])),
      searchIndexPath: readSearchArtifact(path.join(root, "docs/out")).relativePath,
      searchIndexSha256: readSearchArtifact(path.join(root, "docs/out")).sha256,
      results,
    },
    null,
    2
  ) + "\n"
);
console.log(JSON.stringify({ cases: results.length, failures: 0 }));
