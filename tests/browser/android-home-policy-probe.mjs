// Real Android shell in an isolated browser: no native API, phone or game action.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.FIXTURE_ORIGIN || "http://127.0.0.1:8337";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, acceptDownloads: true });
  await context.routeWebSocket(/.*/, () => {});
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/tests/browser/workspace.html?homePolicy=1&profileFeatures=1&lang=en`, { waitUntil: "domcontentloaded" });
  const catalog = await (await page.request.get(`${origin}/locales/en.json`)).json();
  const header = page.locator("header.profile-navigation");
  await page.locator("#tab-alpha").waitFor();
  assert.equal(await header.locator("button[aria-haspopup=menu]").count(), 0);
  assert.equal(await header.getByRole("button", { name: catalog.profile.add, exact: true }).count(), 0);
  await page.locator("#tab-alpha").click({ button: "right" });
  assert.equal(await page.getByRole("menu").count(), 0);
  await page.locator(".home-log-toolbar h2").click({ button: "right" });
  assert.equal(await page.getByRole("menu").count(), 0);
  // The queue remains interactive and never matches a native-preview blocker.
  await page.locator(".task-status-overview").click();
  const queue = page.locator('[data-native-preview-compatible][data-slot="popover-content"]');
  await queue.waitFor();
  assert.equal(await queue.locator("li").count(), 3);
  assert.equal(await queue.getAttribute("data-side"), "bottom");
  const blocked = await queue.evaluate(async (element) => {
    const { ANDROID_PREVIEW_BLOCKERS } = await import("/src/shared/AndroidPreviewInvalidation.ts");
    return element.matches(ANDROID_PREVIEW_BLOCKERS);
  });
  assert.equal(blocked, false);
  await page.keyboard.press("Escape");
  // A real start callback failure enters the profile logger instead of Sonner.
  await page.locator(".mobile-primary-run").click();
  const failure = page.locator("[data-android-profile-log]").getByText("Fixture OCR resource unavailable", { exact: false });
  await failure.waitFor();
  assert.equal(await page.locator("[data-sonner-toast]").count(), 0);
  await page.evaluate(async () => {
    const { useWebSocketStore } = await import("/src/store/WebsocketStore.ts");
    useWebSocketStore.setState({ logStore: { "config:alpha": [] } });
  });
  await failure.waitFor();
  const selection = await failure.evaluate((element) => {
    const text = window.getSelection();
    text.selectAllChildren(element);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return { selected: text.toString(), prevented: event.defaultPrevented };
  });
  assert(selection.selected.includes("Fixture OCR resource unavailable"));
  assert.equal(selection.prevented, false);
  assert.equal(await page.getByRole("menu").count(), 0);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: catalog.log.export, exact: true }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert(Buffer.concat(chunks).toString().includes("Fixture OCR resource unavailable"));
  // Task/config screens retain creation, profile menus and normal context menus.
  for (const destination of ["scheduler", "configuration"]) {
    await page.locator("nav").getByRole("button", { name: catalog.nav[destination], exact: true }).last().click();
    await header.locator("button[aria-haspopup=menu]").first().waitFor();
    assert.equal(await header.getByRole("button", { name: catalog.profile.add, exact: true }).count(), 1);
    await header.locator("button[aria-haspopup=menu]").first().click();
    await page.getByRole("menu").waitFor();
    await page.keyboard.press("Escape");
  }
  await page.locator("nav").getByRole("button", { name: catalog.nav.home, exact: true }).last().click();
  assert.equal(await header.locator("button[aria-haspopup=menu]").count(), 0);
  assert.equal(await header.getByRole("button", { name: catalog.profile.add, exact: true }).count(), 0);
  assert.equal(await page.locator(".mobile-update-log, .mobile-update-actions").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS Android: home actions hidden, long-press blocked, queue stays live, errors in log/export, native log selection retained, task/config menus preserved");
  await context.close();
} finally {
  await browser.close();
}
