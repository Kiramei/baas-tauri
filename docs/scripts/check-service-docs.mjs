import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSearchArtifact } from "./read-search-artifact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = process.argv[2] || "http://127.0.0.1:4173";
const cache = path.join(root, ".cache/service-docs");
mkdirSync(cache, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
let diagramChecks = 0;
try {
  for (const locale of ["zh", "en"]) for (const theme of ["light", "dark"]) for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 } });
    await context.addInitScript((theme) => localStorage.setItem("theme", theme), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    for (const route of ["backend-service", "cli-service"]) {
      assert.equal((await page.goto(`${base}/docs/${locale}/reference/${route}/`)).status(), 200);
      await page.waitForFunction((dark) => document.documentElement.classList.contains("dark") === dark, theme === "dark");
      if (route === "backend-service") {
        await page.waitForFunction(() => document.querySelectorAll(".baas-mermaid-content > svg").length === 2);
        assert.equal(await page.locator(".baas-mermaid-error").count(), 0);
        let index = 0;
        for (const diagram of await page.locator(".baas-mermaid").all()) {
          const chart = diagram.locator(".baas-mermaid-content > svg");
          const width = await chart.evaluate((element) => element.getBoundingClientRect().width);
          assert.ok(width > 0);
          const zoom = diagram.getByRole("button", { name: locale === "zh" ? "放大图表" : "Zoom in diagram", exact: true });
          const reset = diagram.getByRole("button", { name: locale === "zh" ? "重置图表缩放" : "Reset diagram zoom", exact: true });
          await zoom.click();
          assert.equal(await diagram.locator("output").innerText(), "150%");
          assert.ok(Math.abs((await chart.evaluate((element) => element.getBoundingClientRect().width)) / width - 1.5) < 0.01);
          await reset.click();
          assert.equal(await diagram.locator("output").innerText(), "100%");
          await diagram.scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-diagram-${index++}.png`) });
          diagramChecks++;
        }
      } else {
        assert.equal(await page.locator(".baas-mermaid").count(), 0);
        assert.ok((await page.locator("article").innerText()).includes("--no-ocr-update-check"));
        await page.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-cli.png`) });
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      results.push({ kind: "render", locale, theme, mobile, route, passed: true });
    }
    await context.close();
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const locale of ["zh", "en"]) for (const [query, route, title] of [
    ["resume_unavailable", "backend-service", locale === "zh" ? "后端服务接口" : "Backend Service Interfaces"],
    ["cli.example.py", "cli-service", locale === "zh" ? "CLI 与 Service 模式" : "CLI and Service Mode"],
  ]) {
    await page.goto(`${base}/docs/${locale}/`);
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await dialog.locator("input").fill(query);
    await dialog.getByRole("button").filter({ has: page.getByText(title, { exact: true }) }).first().click();
    await page.waitForURL(`**/docs/${locale}/reference/${route}/**`);
    results.push({ kind: "search-navigation", locale, query, route, passed: true });
  }
  await context.close();
} finally { await browser.close(); }
const sha = (file) => createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
const files = ["docs/scripts/check-service-docs.mjs", ...["zh", "en"].flatMap((locale) =>
  ["backend-service", "cli-service"].map((route) => `docs/content/docs/${locale}/reference/${route}.mdx`))];
const report = { checkedAt: new Date().toISOString(), cases: results.length, diagramChecks, failures: 0,
  testedSources: Object.fromEntries(files.map((file) => [file, sha(file)])),
  searchIndexPath: readSearchArtifact(path.join(root, "docs/out")).relativePath,
  searchIndexSha256: readSearchArtifact(path.join(root, "docs/out")).sha256, results };
writeFileSync(path.join(root, "docs/evidence/service-layout-validation.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ cases: report.cases, diagramChecks, failures: 0 }));
