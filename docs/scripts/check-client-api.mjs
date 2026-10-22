import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createExportServer } from "./static-export-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { values, positionals } = parseArgs({
  allowPositionals: true, options: { channel: { type: "string", default: "msedge" } },
});
let server;
const base = positionals[0] || await (async () => {
  server = createExportServer(path.join(root, "docs/out"));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${server.address().port}`;
})();
const origin = new URL(base).origin;
const cache = path.join(root, ".cache/deployment/client-api");
mkdirSync(cache, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
let browser;
const results = [];
try {
  browser = await chromium.launch({ ...(values.channel === "chromium" ? {} : { channel: values.channel }), headless: true });
  for (const locale of ["en", "zh"]) for (const theme of ["light", "dark"]) for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
      hasTouch: mobile,
    });
    await context.addInitScript(theme => localStorage.setItem("theme", theme), theme);
    const page = await context.newPage();
    const pageErrors = [], failedRequests = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("response", response => {
      if (response.url().startsWith(origin + "/") && response.status() >= 400)
        failedRequests.push(new URL(response.url()).pathname);
    });
    try {
      const route = `/docs/${locale}/reference/client-api/`;
      assert.equal((await page.goto(base + route)).status(), 200);
      await page.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark, theme === "dark");
      await page.locator(".twoslash-hover").first().waitFor();
      let popupChecks = 0;
      for (const [token, expected] of [["snapshot", /LogSnapshot/], ["BackendTransportMode", /shm/]]) {
        const trigger = page.locator("button.twoslash-hover").filter({ hasText: new RegExp(`^${token}$`) }).last();
        await trigger.scrollIntoViewIfNeeded();
        if (mobile) await trigger.tap(); else await trigger.hover();
        const popup = page.locator(".fd-twoslash-popover[data-state=open]");
        await popup.waitFor({ state: "visible" });
        assert.match(await popup.innerText(), expected);
        await popup.evaluate(async element => {
          for (const animation of element.getAnimations()) await animation.finished;
        });
        const box = await popup.boundingBox();
        assert.ok(box && box.x >= -1 && box.x + box.width <= (mobile ? 391 : 1441));
        assert.ok(box.y >= -1 && box.y + box.height <= (mobile ? 845 : 961));
        await page.screenshot({ path: path.join(cache, `${locale}-${theme}-${mobile ? "mobile" : "desktop"}-${token}.png`), animations: "disabled" });
        popupChecks++;
        await page.mouse.move(0, 0);
        await page.keyboard.press("Escape");
        await popup.waitFor({ state: "hidden" });
        await trigger.focus();
        await page.keyboard.press("Enter");
        await popup.waitFor({ state: "visible" });
        assert.match(await popup.innerText(), expected);
        popupChecks++;
        await page.keyboard.press("Escape");
        await popup.waitFor({ state: "hidden" });
      }
      const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
      assert.ok(noOverflow);
      assert.doesNotMatch(await page.locator("article").innerText(), /WorkSpace|[A-Z]:\\|file:\/\/\//);
      await page.goto(`${base}/docs/${locale}/`);
      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog");
      await dialog.locator("input").fill("backend_shm_send_json");
      const title = locale === "zh" ? "客户端原生 API" : "Native Client API";
      await dialog.getByRole("button").filter({ hasText: title }).first().click();
      await page.waitForURL(url => url.pathname === route);
      await page.getByRole("heading", { name: title, exact: true }).waitFor();
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(failedRequests, []);
      results.push({ locale, theme, mobile, popupChecks, searchNavigated: true, noOverflow, pageErrors });
    } finally { await context.close(); }
  }
} finally {
  try { if (browser) await browser.close(); }
  finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
const files = ["docs/scripts/check-client-api.mjs", "docs/source.config.ts", "docs/next.config.mjs", "docs/mdx-components.tsx",
  "docs/app/layout.tsx", "docs/lib/source.ts", "docs/package.json", "src/shared/TauriInvoke.ts", "src/transport/types.ts",
  "src/transport/factory.ts", "src-tauri/src/lib.rs", "src-tauri/src/commands.rs", "src-tauri/src/mobile_commands.rs",
  ".github/workflows/docs-validation.yml",
  ...["en", "zh"].map(locale => `docs/content/docs/${locale}/reference/client-api.mdx`)];
const sha = file => createHash("sha256").update(readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n")).digest("hex");
const report = {
  checkedAt: new Date().toISOString(), cases: results.length, failures: 0, nativeCommandsExecuted: false,
  scope: "Documentation rendering, type popups and search only; no native command, game, device or benchmark was run.",
  testedSources: Object.fromEntries(files.map(file => [file, sha(file)])), results,
};
const json = JSON.stringify(report, null, 2) + "\n";
writeFileSync(path.join(cache, "results.json"), json);
writeFileSync(path.join(root, "docs/evidence/client-api-layout.json"), json);
console.log(JSON.stringify({ cases: results.length, popupChecks: results.reduce((sum, result) => sum + result.popupChecks, 0), failures: 0 }));
