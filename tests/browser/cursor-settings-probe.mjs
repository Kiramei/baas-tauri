// Real desktop settings and pointer CSS; no native calls, windows or notifications.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.FIXTURE_ORIGIN || "http://127.0.0.1:8317";
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.routeWebSocket(/.*/, () => {});
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const url = `${origin}/tests/browser/workspace.html?page=settings&section=appearance&persistCursors=1&theme=${theme}&lang=zh`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const cursors = page.getByRole("switch", { name: "启用 BACursors", exact: true });
    const comet = page.getByRole("switch", { name: "启用 BAComet", exact: true });
    await cursors.waitFor();
    assert.equal(await cursors.getAttribute("aria-checked"), "true");
    assert((await cursors.boundingBox()).y < (await comet.boundingBox()).y);
    const pointers = () =>
      page.evaluate(() => {
        let host = document.querySelector("[data-cursor-probe]");
        if (!host) {
          host = document.createElement("div");
          host.setAttribute("data-cursor-probe", "");
          host.innerHTML = '<div>normal</div><button>button</button><input type="text" />';
          document.body.append(host);
        }
        return [...host.children].map((element) => getComputedStyle(element).cursor);
      });
    let styles = await pointers();
    assert(styles[0].includes("/cursors/normal.cur"));
    assert(styles[1].includes("/cursors/link.cur"));
    assert(styles[2].includes("/cursors/text_static_white.cur"));
    await cursors.click();
    await page.waitForFunction(() => document.documentElement.dataset.baCursors === "disabled");
    styles = await pointers();
    assert(styles.every((value) => !value.includes("url(")));
    assert.equal(
      await page.evaluate(() => JSON.parse(localStorage.getItem("uiSettings")).enableBACursors),
      false
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await cursors.waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.baCursors === "disabled");
    assert.equal(await cursors.getAttribute("aria-checked"), "false");
    styles = await pointers();
    assert(styles.every((value) => !value.includes("url(")));
    await cursors.click();
    await page.waitForFunction(() => document.documentElement.dataset.baCursors === "enabled");
    styles = await pointers();
    assert(styles.every((value) => value.includes("/cursors/")));
    await context.addInitScript(() =>
      localStorage.setItem("uiSettings", JSON.stringify({ enableBACursors: false }))
    );
    await page.route("**/auth/**", (route) => route.abort());
    await page.route("**/health", (route) => route.abort());
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.documentElement.dataset.baCursors === "disabled");
    assert.equal(await page.locator(".app-layout").count(), 0);
    styles = await pointers();
    assert(styles.every((value) => !value.includes("url(")));
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${theme}: default on, above BAComet, all pointer types restore, persisted off, re-enable`
    );
    await context.close();
  }
} finally {
  await browser.close();
}
