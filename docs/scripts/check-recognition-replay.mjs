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
const dataFile = path.join(root, "docs/public/developer/recognition-replay.json");
const data = JSON.parse(readFileSync(dataFile));
const sha = (file) => createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
const testedSources = Object.fromEntries([
  "docs/components/RecognitionReplay.tsx", "docs/app/global.css", "docs/mdx-components.tsx",
  "docs/content/docs/en/reference/backend-development.mdx", "docs/content/docs/zh/reference/backend-development.mdx",
].map((file) => [file, sha(file)]));
const cache = path.join(root, ".cache/docs-recognition-layout");
mkdirSync(cache, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
const errors = [];
let stepChecks = 0;
try {
  for (const locale of ["en", "zh"]) {
    for (const theme of ["light", "dark"]) {
      for (const mobile of [false, true]) {
        const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
        page.on("pageerror", (error) => errors.push(error.message));
        await page.addInitScript((theme) => localStorage.setItem("theme", theme), theme);
        const response = await page.goto(`${base}/docs/${locale}/reference/backend-development/`, { waitUntil: "networkidle" });
        assert.equal(response.status(), 200);
        try {
          await page.waitForSelector(".baas-mermaid-content > svg");
        } catch (error) {
          await page.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-failed.png`) });
          console.error(JSON.stringify({ locale, theme, mobile, url: page.url(), title: await page.title(),
            diagrams: await page.locator(".baas-mermaid").count(), svg: await page.locator(".baas-mermaid-content > svg").count(),
            diagramErrors: await page.locator(".baas-mermaid-error").allTextContents(), errors }));
          throw error;
        }
        assert.equal(await page.locator(".baas-mermaid-error").count(), 0);
        await page.evaluate(() => document.fonts.ready);
        const tool = page.locator(".baas-recognition");
        await tool.scrollIntoViewIfNeeded();
        const next = tool.getByRole("button", { name: locale === "zh" ? "下一步" : "Next step", exact: true });
        const previous = tool.getByRole("button", { name: locale === "zh" ? "上一步" : "Previous step", exact: true });
        const reset = tool.getByRole("button", { name: locale === "zh" ? "回到首步" : "Reset to first step", exact: true });
        const slider = tool.getByRole("slider");
        for (const scenario of data.cases) {
          await tool.getByRole("combobox").selectOption(scenario.id);
          assert.equal(await tool.getAttribute("data-scenario"), scenario.id);
          assert.equal(await slider.inputValue(), "0");
          assert.equal(await previous.isDisabled(), true);
          assert.equal(await reset.isDisabled(), true);
          for (const [index, event] of scenario.events.entries()) {
            assert.equal(await tool.locator("output").getAttribute("data-kind"), event.kind);
            assert.equal(await tool.locator("li[aria-current] .baas-recognition-number").textContent(), String(index + 1));
            const visible = await tool.locator("li[aria-current]").evaluate((node) => {
              const bounds = node.parentElement.getBoundingClientRect();
              const row = node.getBoundingClientRect();
              return row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1;
            });
            assert.equal(visible, true, "Selected trace row is outside its own viewport");
            stepChecks++;
            if (index < scenario.events.length - 1) await next.click();
          }
          assert.equal(await next.isDisabled(), true);
          assert.equal(await tool.locator("li code").evaluateAll((nodes) => nodes.some((node) => !node.textContent.trim())), false);
          if (scenario.events.length > 1) {
            await previous.click();
            assert.equal(await slider.inputValue(), String(scenario.events.length - 2));
            await reset.click();
          }
          assert.equal(await slider.inputValue(), "0");
          await slider.focus();
          await slider.press("End");
          assert.equal(await slider.inputValue(), String(scenario.events.length - 1));
          assert.equal(await tool.locator("output").getAttribute("data-kind"), scenario.outcome.kind);
          const bounds = await tool.boundingBox();
          assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= (mobile ? 391 : 1441));
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          if (["repeat-suppressed", "template-end"].includes(scenario.id)) {
            await tool.scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-${scenario.id}.png`) });
          }
          results.push({ locale, theme, mobile, scenario: scenario.id, steps: scenario.events.length, passed: true });
        }
        console.log(JSON.stringify({ locale, theme, mobile, scenarios: data.cases.length, passed: true }));
        await page.close();
      }
    }
  }
  assert.deepEqual(errors, []);
  for (const [file, hash] of Object.entries(testedSources)) assert.equal(sha(file), hash, "Source changed during layout validation");
  const sha256 = createHash("sha256").update(readFileSync(dataFile)).digest("hex");
  const report = { checkedAt: new Date().toISOString(), recognitionReplaySha256: sha256,
    testedSources, cases: results.length, stepChecks, failures: 0, pageErrors: errors, results };
  writeFileSync(path.join(root, "docs/evidence/recognition-layout-validation.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ cases: results.length, stepChecks, failures: 0 }));
} finally {
  await browser.close();
}
