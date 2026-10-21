import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSearchArtifact } from "./read-search-artifact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = process.argv[2] || "http://127.0.0.1:4173";
const cache = path.join(root, ".cache/updater-docs");
mkdirSync(cache, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
const labels = locale => locale === "zh" ? {
  search: "搜索", closeSearch: "关闭搜索", empty: "未找到结果", toc: "本页目录", anchor: "复制章节链接",
  title: "更新器内部机制", openSidebar: "打开侧栏", language: "选择语言", light: "浅色", dark: "深色",
  theme: "切换主题",
} : {
  search: "Search", closeSearch: "Close Search", empty: "No results found", toc: "On this page", anchor: "Copy Anchor Link",
  title: "Updater Internals", openSidebar: "Open Sidebar", language: "Choose language", light: "Light", dark: "Dark",
  theme: "Toggle Theme",
};

try {
  for (const locale of ["zh", "en"]) for (const theme of ["light", "dark"]) for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 } });
    await context.addInitScript(theme => localStorage.setItem("theme", theme), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    const text = labels(locale);
    try {
      assert.equal((await page.goto(`${base}/docs/${locale}/reference/updater-internals/`)).status(), 200);
      await page.getByRole("heading", { name: text.title, exact: true }).waitFor();
      await page.waitForFunction(lang => document.documentElement.lang === lang, locale === "zh" ? "zh-CN" : "en");
      await page.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark, theme === "dark");
      assert.ok(await page.getByRole("button", { name: text.anchor, exact: true }).count() > 0);
      if (!mobile) assert.equal(await page.locator("#toc-title").innerText(), text.toc);

      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog", { name: text.search, exact: true });
      await dialog.getByPlaceholder(text.search, { exact: true }).fill("restart_deferred");
      const result = dialog.getByRole("button").filter({ has: page.getByText(text.title, { exact: true }) }).first();
      await result.waitFor({ state: "visible" });
      assert.equal(await dialog.getByText(labels(locale === "zh" ? "en" : "zh").title, { exact: true }).count(), 0);
      await result.click();
      await page.waitForURL(url => url.pathname.endsWith(`/docs/${locale}/reference/updater-internals/`));
      await page.keyboard.press("Control+k");
      const emptyDialog = page.getByRole("dialog", { name: text.search, exact: true });
      await emptyDialog.getByPlaceholder(text.search, { exact: true }).fill("zz_unmatched_updater_search_49375");
      await emptyDialog.getByText(text.empty, { exact: true }).waitFor();
      await emptyDialog.getByRole("button", { name: text.closeSearch, exact: true }).click();

      const diagram = page.locator(".baas-mermaid");
      await page.waitForFunction(() => document.querySelectorAll(".baas-mermaid-content > svg").length === 1);
      assert.equal(await page.locator(".baas-mermaid-error").count(), 0);
      const svg = diagram.locator(".baas-mermaid-content > svg");
      const width = await svg.evaluate(el => el.getBoundingClientRect().width);
      assert.ok(width > 0);
      await diagram.getByRole("button", { name: locale === "zh" ? "放大图表" : "Zoom in diagram", exact: true }).click();
      assert.equal(await diagram.locator("output").innerText(), "150%");
      assert.ok(Math.abs(await svg.evaluate(el => el.getBoundingClientRect().width) / width - 1.5) < 0.01);
      await diagram.getByRole("button", { name: locale === "zh" ? "重置图表缩放" : "Reset diagram zoom", exact: true }).click();
      assert.equal(await diagram.locator("output").innerText(), "100%");
      await diagram.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

      if (mobile) await page.getByRole("button", { name: text.openSidebar, exact: true }).click();
      const opposite = theme === "dark" ? "light" : "dark";
      await page.getByRole("button", { name: text.theme, exact: true }).filter({ visible: true }).click();
      await page.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark, opposite === "dark");
      await page.getByRole("button", { name: text.theme, exact: true }).filter({ visible: true }).click();
      await page.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark, theme === "dark");

      const nextLocale = locale === "zh" ? "en" : "zh", nextText = labels(nextLocale);
      const menu = page.locator(".baas-language-menu");
      await menu.locator("summary").filter({ visible: true }).click();
      assert.equal(await menu.locator("summary").getAttribute("aria-label"), text.language);
      await menu.getByRole("link", { name: nextLocale === "en" ? "English" : "中文", exact: true }).click();
      await page.waitForURL(url => url.pathname.endsWith(`/docs/${nextLocale}/reference/updater-internals/`));
      await page.getByRole("heading", { name: nextText.title, exact: true }).waitFor();
      await page.waitForFunction(lang => document.documentElement.lang === lang, nextLocale === "zh" ? "zh-CN" : "en");
      await page.getByRole("button", { name: nextText.anchor, exact: true }).first().waitFor({ state: "attached" });
      assert.equal(await page.getByRole("button", { name: text.anchor, exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem("baas-docs-locale")), nextLocale);
      await page.keyboard.press("Control+k");
      await page.getByRole("dialog", { name: nextText.search, exact: true }).getByPlaceholder(nextText.search, { exact: true }).waitFor();
      await page.getByRole("dialog").getByRole("button", { name: nextText.closeSearch, exact: true }).click();
      assert.deepEqual(errors, []);
      results.push({ locale, theme, mobile, searchNavigated: true, emptySearchTranslated: true, frameworkLabelsTranslated: true,
        clientLanguageSwitch: true, themeSwitch: true, diagramZoomAndReset: true, noOverflow: true, pageErrors: errors, passed: true });
    } catch (error) {
      await page.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-failed.png`) });
      console.error(JSON.stringify({ locale, theme, mobile, url: page.url(), errors }));
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
const files = ["docs/scripts/check-updater-docs.mjs", "docs/components/DocsProvider.tsx", "docs/components/FlexSearchDialog.tsx",
  "docs/lib/search-index.ts", "docs/lib/search-encoding.ts", "docs/lib/search-contract.ts",
  "docs/lib/search-artifact.server.ts", "docs/lib/build-search-index.ts", "docs/app/search-index/[file]/route.ts",
  "docs/scripts/read-search-artifact.mjs",
  "docs/components/LanguageMenu.tsx", "docs/app/layout.tsx", "docs/lib/locale.ts", "docs/lib/ui-translations.ts",
  ...["zh", "en"].map(locale => `docs/content/docs/${locale}/reference/updater-internals.mdx`)];
const sha = file => createHash("sha256").update(readFileSync(path.join(root, file)).toString().replaceAll("\r\n", "\n")).digest("hex");
writeFileSync(path.join(root, "docs/evidence/updater-layout.json"), JSON.stringify({ checkedAt: new Date().toISOString(),
  cases: results.length, failures: 0, testedSources: Object.fromEntries(files.map(file => [file, sha(file)])),
  searchIndexPath: readSearchArtifact(path.join(root, "docs/out")).relativePath,
  searchIndexSha256: readSearchArtifact(path.join(root, "docs/out")).sha256, results }, null, 2) + "\n");
console.log(JSON.stringify({ cases: results.length, failures: 0 }));
