import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createExportServer } from "./static-export-server.mjs";
import { readSearchArtifact } from "./read-search-artifact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({ options: {
  out: { type: "string", default: "docs/out" }, "base-path": { type: "string", default: "" },
  channel: { type: "string", default: "msedge" }, report: { type: "string" },
} });
const out = path.resolve(root, values.out), prefix = values["base-path"];
const artifact = readSearchArtifact(out);
const currentPath = prefix + "/" + artifact.relativePath;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const cache = path.join(root, ".cache/deployment", prefix ? "search-cache-prefixed" : "search-cache-root");
mkdirSync(cache, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const Search = createRequire(path.join(root, "docs/package.json"))("flexsearch");
const oldIndex = new Search.Document({ tokenize: "full", document: { id: "id", index: ["content"], tag: ["tags"], store: true } });
oldIndex.add({ id: "old", page_id: "old", type: "page", content: "old_cache_marker_42873", tags: [], url: "/docs/en/" });
const raw = {};
await oldIndex.export((key, value) => { raw[key] = value; });
const oldContent = { format: artifact.payload.format, indexes: { type: "default", raw } };
const oldRevision = hash(JSON.stringify(oldContent));
const oldBody = JSON.stringify({ revision: oldRevision, ...oldContent });
const oldPath = prefix + "/search-index/" + oldRevision + ".json";
assert.notEqual(oldRevision, artifact.revision);

const staticServer = createExportServer(out, prefix);
const staticHandler = staticServer.listeners("request")[0];
let scenario;
const json = (response, status, bytes, cached) => {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": cached ? "public, max-age=31536000" : "no-store" });
  response.end(bytes);
};
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://fixture.invalid").pathname;
  if (scenario && [oldPath, prefix + "/search-index.json"].includes(pathname)) {
    scenario.requests[pathname === oldPath ? "old" : "legacy"]++;
    json(response, 200, oldBody, true);
  } else if (scenario && pathname === currentPath) {
    scenario.requests.current++;
    if (scenario.requests.current === 1 && scenario.failure === "missing") json(response, 404, "{}", false);
    else if (scenario.requests.current === 1 && scenario.failure === "revision") json(response, 200, oldBody, true);
    else json(response, 200, artifact.bytes, true);
  } else staticHandler(request, response);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const results = [];
try {
  browser = await chromium.launch({ ...(values.channel === "chromium" ? {} : { channel: values.channel }), headless: true });
  for (const locale of ["zh", "en"]) for (const theme of ["light", "dark"]) for (const mobile of [false, true]) {
    for (const failure of ["cached-old", "missing", "revision"]) {
      scenario = { failure, requests: { current: 0, old: 0, legacy: 0 } };
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 } });
      await context.addInitScript(theme => localStorage.setItem("theme", theme), theme);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(String(error)));
      const text = locale === "zh"
        ? { search: "搜索", title: "更新器内部机制", changed: "此页的搜索索引已不可用。", reload: "重新加载文档", retry: "重新搜索", empty: "未找到结果" }
        : { search: "Search", title: "Updater Internals", changed: "The search index for this page is no longer available.", reload: "Reload documentation", retry: "Retry search", empty: "No results found" };
      try {
        assert.equal((await page.goto(`${origin}${prefix}/docs/${locale}/`)).status(), 200);
        assert.equal(await page.locator('meta[name="baas-search-index"]').getAttribute("content"), currentPath);
        await page.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark, theme === "dark");
        if (failure === "cached-old") {
          for (const url of [oldPath, prefix + "/search-index.json"]) for (let repeat = 0; repeat < 2; repeat++) {
            assert.equal(await page.evaluate(async url => (await (await fetch(url)).json()).revision, url), oldRevision);
          }
          assert.deepEqual(scenario.requests, { current: 0, old: 1, legacy: 1 }, "The negative control must actually hit the browser HTTP cache");
        }
        await page.keyboard.press("Control+k");
        let dialog = page.getByRole("dialog", { name: text.search, exact: true });
        await dialog.locator("input").fill("restart_deferred");
        let recovery = "none";
        if (failure !== "cached-old") {
          await dialog.getByRole("alert").getByText(text.changed, { exact: true }).waitFor();
          assert.equal(scenario.requests.current, 1);
          assert.equal(await dialog.getByRole("button", { name: text.retry, exact: true }).count(), 0);
          const reload = dialog.getByRole("button", { name: text.reload, exact: true });
          assert.equal(await reload.getAttribute("title"), text.reload);
          await dialog.evaluate(async element => { for (const animation of element.getAnimations({ subtree: true })) await animation.finished; });
          assert.ok(await dialog.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
          }));
          await page.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-${failure}.png`) });
          const loaded = page.waitForEvent("load");
          if (failure === "revision" && mobile) {
            await dialog.locator("input").press("Enter");
            recovery = "enter-reload";
          } else {
            await reload.click();
            recovery = "button-reload";
          }
          await loaded;
          assert.equal(new URL(page.url()).pathname, `${prefix}/docs/${locale}/`);
          await page.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark, theme === "dark");
          await page.keyboard.press("Control+k");
          dialog = page.getByRole("dialog", { name: text.search, exact: true });
          await dialog.locator("input").fill("restart_deferred");
        }
        await dialog.getByRole("button").filter({ has: page.getByText(text.title, { exact: true }) }).first().waitFor({ state: "visible" });
        assert.equal(await dialog.getByRole("alert").count(), 0);
        await dialog.locator("input").fill("old_cache_marker_42873");
        await dialog.getByText(text.empty, { exact: true }).waitFor();
        assert.equal(scenario.requests.current, failure === "cached-old" ? 1 : 2);
        if (failure === "cached-old") assert.deepEqual(scenario.requests, { current: 1, old: 1, legacy: 1 });
        assert.deepEqual(errors, []);
        results.push({ locale, theme, mobile, failure, recovery, requests: { ...scenario.requests },
          currentResultsFound: true, oldMarkerAbsent: true, pageErrors: errors, passed: true });
      } catch (error) {
        await page.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-${failure}-failed.png`) });
        writeFileSync(path.join(cache, "failure.json"), JSON.stringify({ locale, theme, mobile, failure, error: error.message, requests: scenario.requests, errors, results }, null, 2));
        throw error;
      } finally { await context.close(); }
    }
  }
  scenario = undefined;
  assert.equal((await fetch(origin + prefix + "/search-index.json")).status, 404);
  const files = ["docs/scripts/check-search-cache.mjs", "docs/scripts/read-search-artifact.mjs", "docs/scripts/static-export-server.mjs",
    "docs/lib/search-contract.ts", "docs/lib/search-index.ts", "docs/lib/search-artifact.server.ts", "docs/lib/build-search-index.ts",
    "docs/lib/search-encoding.ts", "docs/app/search-index/[file]/route.ts", "docs/components/FlexSearchDialog.tsx",
    "docs/components/DocsProvider.tsx", "docs/app/layout.tsx"];
  const report = { checkedAt: new Date().toISOString(), platform: process.platform, basePath: prefix,
    scope: "Real browser HTTP cache, stale-revision rejection and reload recovery; no game or emulator operated",
    cases: results.length, failures: 0, searchIndexPath: artifact.relativePath, searchIndexRevision: artifact.revision,
    searchIndexSha256: artifact.sha256, testedSources: Object.fromEntries(files.map(file => [file, hash(readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n"))])), results };
  writeFileSync(path.join(cache, "results.json"), JSON.stringify(report, null, 2) + "\n");
  if (values.report) writeFileSync(path.resolve(root, values.report), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ cases: report.cases, failures: 0, basePath: prefix }));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
