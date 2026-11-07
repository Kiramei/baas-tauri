import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createExportServer } from "./static-export-server.mjs";
import { readSearchArtifact } from "./read-search-artifact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({
  options: {
    out: { type: "string", default: "docs/out" },
    "base-path": { type: "string", default: "" },
    report: { type: "string" },
    channel: { type: "string", default: "msedge" },
  },
});
const out = path.resolve(root, values.out),
  basePath = values["base-path"];
const searchIndex = readSearchArtifact(out);
const cache = path.join(
  root,
  ".cache/deployment",
  basePath ? basePath.slice(1).replaceAll("/", "-") : "root"
);
mkdirSync(cache, { recursive: true });
const server = createExportServer(out, basePath);
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
let browser, origin, site;
const failures = [],
  requestsFailed = [],
  cases = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceFiles = [
  "docs/next.config.mjs",
  "docs/app/layout.tsx",
  "docs/app/LocalizedDocument.tsx",
  "docs/app/docs/[lang]/layout.tsx",
  "docs/app/global.css",
  "docs/lib/remark-doc-links.mjs",
  "docs/lib/search-index.ts",
  "docs/lib/search-encoding.ts",
  "docs/lib/search-contract.ts",
  "docs/lib/search-artifact.server.ts",
  "docs/lib/build-search-index.ts",
  "docs/app/search-index/[file]/route.ts",
  "docs/components/DocsProvider.tsx",
  "docs/components/SidebarFolder.tsx",
  "docs/components/LocalizedDocs.tsx",
  "docs/components/FlexSearchDialog.tsx",
  "docs/scripts/read-search-artifact.mjs",
  "docs/components/LocaleEntry.tsx",
  "docs/components/LanguageMenu.tsx",
  "docs/lib/locale.ts",
  "docs/components/DocumentationLink.tsx",
  "docs/mdx-components.tsx",
  "docs/scripts/static-export-server.mjs",
  "docs/scripts/normalize-static-export.mjs",
  "docs/package.json",
  "docs/scripts/check-deployment.mjs",
  ".github/workflows/docs-validation.yml",
];
const checkedSources = Object.fromEntries(
  sourceFiles.map((file) => [
    file,
    hash(readFileSync(path.join(root, file)).toString().replaceAll("\r\n", "\n")),
  ])
);
const routes = readdirSync(path.join(root, "docs/content/docs/en"), { recursive: true })
  .filter((file) => file.endsWith(".mdx"))
  .map((file) => file.slice(0, -4).replaceAll("\\", "/"))
  .map((route) => route.replace(/(^|\/)index$/, "").replace(/\/$/, ""))
  .sort();

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  site = origin + basePath;
  browser = await chromium.launch({
    ...(values.channel === "chromium" ? {} : { channel: values.channel }),
    headless: true,
  });
  for (const locale of ["en", "zh"])
    for (const theme of ["light", "dark"])
      for (const mobile of [false, true]) {
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
        });
        await context.addInitScript(({ theme, locale }) => {
          localStorage.setItem("theme", theme);
          localStorage.setItem("baas-docs-locale", locale);
        }, { theme, locale });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        page.on("response", (response) => {
          if (response.url().startsWith(origin + "/") && response.status() >= 400)
            requestsFailed.push({
              path: new URL(response.url()).pathname,
              status: response.status(),
            });
        });
        try {
          for (const route of routes) {
            const pathname = `/docs/${route ? route + "/" : ""}`;
            assert.equal((await page.goto(site + pathname)).status(), 200);
            await page.locator("h1").waitFor();
            await page.waitForFunction(
              (language) => document.documentElement.lang === language,
              locale === "zh" ? "zh-CN" : "en"
            );
            assert.equal(await page.locator('meta[name="baas-search-index"]').getAttribute("content"),
              `${basePath}/${searchIndex.relativePath}`);
            await page.waitForFunction(
              (dark) => document.documentElement.classList.contains("dark") === dark,
              theme === "dark"
            );
            await page.evaluate(() => document.fonts.ready);
            assert.ok(
              await page.evaluate(async () => {
                const fonts = await document.fonts.load('16px "Blueaka"');
                return fonts.length > 0 && fonts.every((font) => font.status === "loaded");
              }),
              "The custom font must load, not fall back silently"
            );
            const invalid = await page.evaluate(
              async ({ basePath, origin }) => {
                const failures = [];
                const attributes = [
                  ["a[href],link[href]:not([rel='preconnect']):not([rel='dns-prefetch'])", "href"],
                  ["img[src],video[src],source[src],script[src]", "src"],
                ];
                for (const [selector, attribute] of attributes)
                  for (const element of document.querySelectorAll(selector)) {
                    const value = element.getAttribute(attribute);
                    if (!value || value.startsWith("#")) continue;
                    const url = new URL(value, location.href);
                    if (url.origin === origin && !url.pathname.startsWith(basePath + "/"))
                      failures.push({ value, reason: "outside deployment prefix" });
                    if (
                      basePath &&
                      url.origin === origin &&
                      url.pathname.startsWith(basePath + basePath + "/")
                    )
                      failures.push({ value, reason: "duplicate deployment prefix" });
                  }
                for (const image of document.querySelectorAll(
                  "img.baas-screenshot, .baas-doc-nav-brand img"
                )) {
                  image.scrollIntoView();
                  try {
                    await image.decode();
                  } catch {
                    failures.push({
                      value: image.getAttribute("src"),
                      reason: "image decode failed",
                    });
                  }
                  if (image.classList.contains("baas-screenshot")) {
                    const style = getComputedStyle(image);
                    if (style.borderRadius !== "8px" || style.boxShadow === "none")
                      failures.push({
                        value: image.getAttribute("src"),
                        reason: "missing screenshot framing",
                      });
                  }
                }
                if (document.documentElement.scrollWidth > innerWidth + 1)
                  failures.push({ reason: "page overflow" });
                return failures;
              },
              { basePath, origin }
            );
            failures.push(
              ...invalid.map((failure) => ({ locale, theme, mobile, route, ...failure }))
            );
            cases.push({ kind: "render", locale, theme, mobile, route });
            if (route === "reference/performance") {
              const assetPath = basePath + "/benchmarks/native-transport-current.json";
              const responsePromise = page.waitForResponse(
                (response) =>
                  new URL(response.url()).pathname === assetPath &&
                  response.request().isNavigationRequest()
              );
              await page.locator(`a[href='${assetPath}']`).click();
              const response = await responsePromise;
              await page.waitForURL((url) => url.pathname === assetPath);
              assert.equal(response.status(), 200);
              assert.equal(
                hash(await response.body()),
                hash(readFileSync(path.join(out, "benchmarks/native-transport-current.json")))
              );
              cases.push({ kind: "raw-record-link", locale, theme, mobile });
            }
            if (route === "guide/android") {
              const demo = page.locator(".baas-android-game-demo"),
                image = demo.locator("img");
              await demo
                .getByRole("button", {
                  name: locale === "zh" ? "播放演示" : "Play demonstration",
                  exact: true,
                })
                .click();
              await image.evaluate(async (element) => {
                await element.decode();
              });
              assert.ok((await image.getAttribute("src")).startsWith(basePath + "/media/"));
              const first = hash(await image.screenshot());
              await page.waitForTimeout(450);
              assert.notEqual(hash(await image.screenshot()), first);
              await demo
                .getByRole("button", {
                  name: locale === "zh" ? "停止演示" : "Stop demonstration",
                  exact: true,
                })
                .click();
              await image.evaluate(async (element) => {
                await element.decode();
              });
              await image.click();
              await page.locator(".baas-image-zoom img").evaluate(async (element) => {
                await element.decode();
              });
              await page.keyboard.press("Escape");
              await page.locator(".baas-image-zoom").waitFor({ state: "detached" });
              cases.push({ kind: "motion-and-zoom", locale, theme, mobile });
            }
          }
          const label = locale === "zh" ? "搜索" : "Search";
          await page.goto(`${site}/docs/`);
          await page.evaluate(() => {
            window.__deploymentNavigationToken = "retained";
          });
          await page
            .locator(`a[href='${basePath}/docs/guide/configuration/']`)
            .filter({ visible: true })
            .first()
            .click();
          await page.waitForURL(
            (url) => url.pathname === `${basePath}/docs/guide/configuration/`
          );
          assert.equal(
            await page.evaluate(() => window.__deploymentNavigationToken),
            "retained",
            "Documentation navigation must not fall back to a full reload"
          );
          cases.push({ kind: "client-navigation", locale, theme, mobile });
          await page.evaluate(() => {
            window.__deploymentSearchEvents = [];
            const record = (event) => {
              const events = window.__deploymentSearchEvents;
              if (events.length >= 200) return;
              const target = event.target instanceof Element ? event.target.closest("button, input") : null;
              events.push({ type: event.type, phase: event.eventPhase, at: performance.now(),
                key: event.key, x: event.clientX, y: event.clientY, prevented: event.defaultPrevented,
                target: target?.tagName, label: target?.textContent?.slice(0, 160), selected: target?.getAttribute("aria-selected") });
            };
            for (const type of ["pointermove", "pointerdown", "pointerup", "click", "keydown"]) {
              document.addEventListener(type, record, { capture: true, passive: true });
              document.addEventListener(type, record, { passive: true });
            }
          });
          await page.keyboard.press("Control+k");
          const dialog = page.getByRole("dialog", { name: label, exact: true });
          await dialog.locator("input").fill("restart_deferred");
          const result = dialog
            .getByRole("button")
            .filter({
              has: page.getByText(locale === "zh" ? "更新器内部机制" : "Updater Internals", {
                exact: true,
              }),
            })
            .first();
          await result.click();
          await page.waitForURL(
            (url) => url.pathname === `${basePath}/docs/reference/updater-internals/`
          );
          cases.push({ kind: "search-navigation", locale, theme, mobile });
          assert.equal(await page.evaluate(() => window.__deploymentNavigationToken), "retained");
          if (mobile)
            await page
              .getByRole("button", {
                name: locale === "zh" ? "打开侧栏" : "Open Sidebar",
                exact: true,
              })
              .click();
          const menu = page.locator(".baas-language-menu");
          await menu.locator("summary").filter({ visible: true }).click();
          const next = locale === "zh" ? "en" : "zh";
          await menu
            .getByRole("link", { name: next === "en" ? "English" : "中文", exact: true })
            .click();
          await page.waitForURL(
            (url) => url.pathname === `${basePath}/docs/reference/updater-internals/`
          );
          await page.waitForFunction(
            (language) => document.documentElement.lang === language,
            next === "zh" ? "zh-CN" : "en"
          );
          assert.equal(await page.evaluate(() => localStorage.getItem("baas-docs-locale")), next);
          cases.push({ kind: "language-switch", locale, theme, mobile });
          assert.equal(await page.evaluate(() => window.__deploymentNavigationToken), "retained");
          assert.deepEqual(errors, []);
          await page.screenshot({
            path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}.png`),
          });
        } catch (error) {
          await writeFile(path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-interaction.json`),
            JSON.stringify({ locale, theme, mobile, url: page.url(), pageErrors: errors,
              search: await page.evaluate(() => ({ events: window.__deploymentSearchEvents ?? [],
                dialogOpen: Boolean(document.querySelector("[role=dialog]")),
                buttons: [...document.querySelectorAll("[role=dialog] button")].map(button => ({
                  label: button.textContent?.slice(0, 160), selected: button.getAttribute("aria-selected"),
                  rect: button.getBoundingClientRect().toJSON() })) })).catch(reason => ({ collectionError: String(reason) })),
            }, null, 2) + "\n");
          failures.push(...errors.map(message => ({ locale, theme, mobile, reason: "pageerror", message })));
          await page.screenshot({
            path: path.join(
              cache,
              `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-failed.png`
            ),
          });
          throw error;
        } finally {
          await context.close();
        }
      }
  for (const entry of ["/", "/docs/", "/docs/guide/configuration/"])
    for (const [language, saved, expected, denied] of [
      ["zh-CN", null, "zh", false],
      ["ja-JP", null, "en", false],
      ["en-US", "zh", "zh", false],
      ["zh-CN", "en", "en", false],
      ["zh-CN", null, "zh", true],
    ]) {
      const context = await browser.newContext({ locale: language });
      await context.addInitScript(({ saved, denied }) => {
        if (saved) localStorage.setItem("baas-docs-locale", saved);
        if (denied) {
          Object.defineProperty(Storage.prototype, "getItem", { value() { throw new Error("Storage disabled"); } });
          Object.defineProperty(Storage.prototype, "setItem", { value() { throw new Error("Storage disabled"); } });
        }
      }, { saved, denied });
      const page = await context.newPage();
      try {
        assert.equal((await page.goto(site + entry + "?deployment=1#entry")).status(), 200);
        await page.waitForFunction(
          (language) => document.documentElement.lang === language,
          expected === "zh" ? "zh-CN" : "en"
        );
        await page.getByRole("heading", { level: 1 }).waitFor();
        assert.equal(new URL(page.url()).pathname, `${basePath}${entry}`);
        assert.equal(new URL(page.url()).search, "?deployment=1");
        assert.equal(new URL(page.url()).hash, "#entry");
        cases.push({ kind: "entry", entry, language, saved, expected, denied });
      } finally {
        await context.close();
      }
    }
  for (const locale of ["zh", "en"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      assert.equal((await page.goto(`${site}/docs/${locale}/guide/configuration/?legacy=1#entry`)).status(), 200);
      await page.waitForFunction(
        (language) => document.documentElement.lang === language,
        locale === "zh" ? "zh-CN" : "en"
      );
      assert.equal(await page.locator("#nd-sidebar").getByRole("button", {
        name: locale === "zh" ? "使用指南" : "User Guide", exact: true,
      }).getAttribute("aria-expanded"), "true");
      assert.equal(new URL(page.url()).search, "?legacy=1");
      assert.equal(new URL(page.url()).hash, "#entry");
      cases.push({ kind: "legacy-entry", locale });
    } finally {
      await context.close();
    }
  }
  {
    const context = await browser.newContext({ locale: "en-US" });
    await context.addInitScript(() => {
      for (const method of ["getItem", "setItem"]) {
        Object.defineProperty(Storage.prototype, method, {
          value() { throw new Error("Storage disabled"); },
        });
      }
    });
    const page = await context.newPage();
    try {
      await page.goto(`${site}/docs/?deployment=1#entry`);
      await page.waitForFunction(() => document.documentElement.lang === "en");
      const menu = page.locator(".baas-language-menu");
      await menu.locator("summary").filter({ visible: true }).click();
      await menu.getByRole("link", { name: "中文", exact: true }).click();
      await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
      assert.equal(new URL(page.url()).pathname, `${basePath}/docs/`);
      assert.equal(new URL(page.url()).search, "?deployment=1");
      assert.equal(new URL(page.url()).hash, "#entry");
      await page.locator(`a[href='${basePath}/docs/guide/configuration/']`)
        .filter({ visible: true }).first().click();
      await page.waitForURL((url) => url.pathname === `${basePath}/docs/guide/configuration/`);
      await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
      cases.push({ kind: "language-switch-without-storage" });
    } finally {
      await context.close();
    }
  }
  {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      assert.equal((await page.goto(`${site}/docs/guide/configuration/`)).status(), 200);
      await page.getByRole("heading", { level: 1 }).waitFor();
      cases.push({ kind: "static-document-without-javascript" });
    } finally {
      await context.close();
    }
  }
  for (const [locale, labels] of [
    ["zh-CN", ["使用指南", "功能配置", "开发者", "BAASX", "Android", "Docker", "其他"]],
    ["en-US", ["User Guide", "Feature Configuration", "Developers", "BAASX", "Android", "Docker", "Other"]],
  ]) {
    const context = await browser.newContext({ locale, viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    try {
      for (const entry of ["/", "/docs/baasx/installation/"]) {
        assert.equal((await page.goto(site + entry)).status(), 200);
        await page.waitForFunction((language) => document.documentElement.lang === language,
          locale === "zh-CN" ? "zh-CN" : "en");
        const sidebar = page.locator("#nd-sidebar");
        for (const [index, label] of labels.entries()) {
          const expected = entry === "/" || index !== 3 ? "false" : "true";
          assert.equal(await sidebar.getByRole("button", { name: label, exact: true })
            .getAttribute("aria-expanded"), expected);
        }
      }
      const sidebar = page.locator("#nd-sidebar");
      const reference = sidebar.getByRole("button", { name: labels[2], exact: true });
      await reference.click();
      assert.equal(await reference.getAttribute("aria-expanded"), "true");
      const menu = page.locator(".baas-language-menu").filter({ visible: true });
      await menu.locator("summary").click();
      await menu.getByRole("link", { name: locale === "zh-CN" ? "English" : "中文", exact: true }).click();
      await page.waitForFunction((language) => document.documentElement.lang === language,
        locale === "zh-CN" ? "en" : "zh-CN");
      assert.equal(await sidebar.getByRole("button", { name: "BAASX", exact: true })
        .getAttribute("aria-expanded"), "true");
      assert.equal(await sidebar.getByRole("button", {
        name: locale === "zh-CN" ? "Developers" : "开发者", exact: true,
      }).getAttribute("aria-expanded"), "true");
      await menu.locator("summary").click();
      await menu.getByRole("link", { name: locale === "zh-CN" ? "中文" : "English", exact: true }).click();
      await page.waitForFunction((language) => document.documentElement.lang === language,
        locale === "zh-CN" ? "zh-CN" : "en");
      const guide = sidebar.getByRole("button", { name: labels[0], exact: true });
      await guide.click();
      assert.equal(await guide.getAttribute("aria-expanded"), "true");
      const android = sidebar.getByRole("button", { name: "Android", exact: true });
      await android.click();
      await sidebar.locator(`a[href='${basePath}/docs/android/install/']`).click();
      await page.waitForURL((url) => url.pathname === `${basePath}/docs/android/install/`);
      assert.equal(await guide.getAttribute("aria-expanded"), "true");
      assert.equal(await android.getAttribute("aria-expanded"), "true");
      assert.equal(await sidebar.getByRole("button", { name: "BAASX", exact: true })
        .getAttribute("aria-expanded"), "false");
      assert.equal(await reference.getAttribute("aria-expanded"), "true");
      await page.reload();
      assert.equal(await guide.getAttribute("aria-expanded"), "false");
      assert.equal(await android.getAttribute("aria-expanded"), "true");
      assert.equal(await reference.getAttribute("aria-expanded"), "false");
      cases.push({ kind: "sidebar-active-folder", locale });
    } finally {
      await context.close();
    }
  }
  {
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await page.goto(`${site}/docs/baasx/installation/`);
      await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
      await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
      for (const [index, label] of ["使用指南", "功能配置", "开发者", "BAASX"].entries()) {
        assert.equal(await page.getByRole("button", { name: label, exact: true })
          .filter({ visible: true }).getAttribute("aria-expanded"), index === 3 ? "true" : "false");
      }
      cases.push({ kind: "mobile-sidebar-active-folder" });
    } finally {
      await context.close();
    }
  }
  assert.equal((await fetch(site + "/search-index.json")).status, 404,
    "The unversioned endpoint must not serve a new index to an old client");
  cases.push({ kind: "search-artifact", revision: searchIndex.revision });
  const cssFiles = readdirSync(path.join(out, "_next/static/chunks")).filter((file) =>
    file.endsWith(".css")
  );
  assert.ok(cssFiles.length > 0);
  const css = cssFiles
    .map((file) => readFileSync(path.join(out, "_next/static/chunks", file), "utf8"))
    .join("\n");
  if (/url\(["']?\/(?:fonts|cursors)\//.test(css))
    failures.push({ reason: "CSS requests unprefixed public font/cursor assets" });
  const missing = [...new Map(requestsFailed.map((failure) => [failure.path, failure])).values()];
  failures.push(
    ...missing.map((failure) => ({ ...failure, reason: "HTTP error from strict static host" }))
  );
  const report = {
    checkedAt: new Date().toISOString(),
    sourceRevision: process.env.GITHUB_SHA,
    platform: process.platform,
    basePath,
    strictStaticHost: true,
    nextVersion: JSON.parse(readFileSync(path.join(root, "docs/node_modules/next/package.json")))
      .version,
    testedSources: checkedSources,
    cases,
    caseCount: cases.length,
    failures,
    searchIndexPath: searchIndex.relativePath,
    searchIndexRevision: searchIndex.revision,
    searchIndexSha256: searchIndex.sha256,
  };
  await writeFile(path.join(cache, "results.json"), JSON.stringify(report, null, 2) + "\n");
  if (values.report)
    await writeFile(path.resolve(root, values.report), JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({ cases: cases.length, failures: failures.length, paths: missing.slice(0, 15) })
  );
  assert.equal(failures.length, 0, "Deployment resources or navigation failed");
} catch (error) {
  await writeFile(
    path.join(cache, "failure.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        platform: process.platform,
        basePath,
        error: error.message,
        cases,
        failures,
        requestsFailed,
      },
      null,
      2
    ) + "\n"
  );
  throw error;
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    if (server.listening)
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
  }
}
