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
  "docs/app/docs/[lang]/layout.tsx",
  "docs/app/global.css",
  "docs/lib/remark-doc-links.mjs",
  "docs/lib/search-index.ts",
  "docs/lib/search-encoding.ts",
  "docs/app/search-index.json/route.ts",
  "docs/components/LocaleEntry.tsx",
  "docs/components/LanguageMenu.tsx",
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
  .map((route) => (route === "index" ? "" : route))
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
        await context.addInitScript((theme) => localStorage.setItem("theme", theme), theme);
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
            const pathname = `/docs/${locale}/${route ? route + "/" : ""}`;
            assert.equal((await page.goto(site + pathname)).status(), 200);
            await page.locator("h1").waitFor();
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
          await page.goto(`${site}/docs/${locale}/`);
          await page.evaluate(() => {
            window.__deploymentNavigationToken = "retained";
          });
          await page
            .locator(`a[href='${basePath}/docs/${locale}/guide/configuration/']`)
            .filter({ visible: true })
            .first()
            .click();
          await page.waitForURL(
            (url) => url.pathname === `${basePath}/docs/${locale}/guide/configuration/`
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
            (url) => url.pathname === `${basePath}/docs/${locale}/reference/updater-internals/`
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
            (url) => url.pathname === `${basePath}/docs/${next}/reference/updater-internals/`
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
  for (const entry of ["/", "/docs/"])
    for (const [language, saved, expected] of [
      ["zh-CN", null, "zh"],
      ["ja-JP", null, "en"],
      ["en-US", "zh", "zh"],
    ]) {
      const context = await browser.newContext({ locale: language });
      if (saved)
        await context.addInitScript(
          (saved) => localStorage.setItem("baas-docs-locale", saved),
          saved
        );
      const page = await context.newPage();
      try {
        await page.goto(site + entry + "?deployment=1#entry");
        await page.waitForURL((url) => url.pathname === `${basePath}/docs/${expected}/`);
        assert.equal(new URL(page.url()).search, "?deployment=1");
        assert.equal(new URL(page.url()).hash, "#entry");
        cases.push({ kind: "entry", entry, language, saved, expected });
      } finally {
        await context.close();
      }
    }
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
    searchIndexSha256: hash(readFileSync(path.join(out, "search-index.json"))),
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
