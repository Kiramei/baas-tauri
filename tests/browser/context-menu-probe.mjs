// Real desktop context menu and controlled editors. Clipboard data is entirely synthetic.
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.FIXTURE_ORIGIN || "http://127.0.0.1:8338";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  await context.routeWebSocket(/.*/, () => {});
  await context.addInitScript(() => {
    window.fixtureClipboard = "";
    Object.defineProperty(navigator, "clipboard", { value: {
      writeText: async (text) => { window.fixtureClipboard = text; },
      readText: async () => window.fixtureClipboard,
    } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/tests/browser/workspace.html?homePolicy=1&profileFeatures=1&lang=en`, { waitUntil: "domcontentloaded" });
  await page.locator("#tab-alpha").waitFor();
  const labels = (await (await page.request.get(`${origin}/locales/en.json`)).json()).contextMenu;
  await page.getByRole("button", { name: "Editors", exact: true }).click();
  const menu = page.locator("[data-context-menu][role=menu]");
  const input = page.locator('[data-fixture-editor="input"]');
  const openInput = async () => {
    await input.evaluate((element) => {
      element.focus(); element.setSelectionRange(6, 11);
      element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 120 }));
    });
    await menu.waitFor();
  };
  await openInput();
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), [`${labels.copy}Ctrl+C`, `${labels.paste}Ctrl+V`]);
  assert.equal(await menu.getByRole("separator").count(), 0);
  await menu.getByRole("menuitem").first().click();
  assert.equal(await page.evaluate(() => window.fixtureClipboard), "bravo");
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);

  await page.evaluate(() => { window.fixtureClipboard = "剪贴"; });
  await openInput();
  await page.keyboard.press("End");
  assert.equal(await menu.getByRole("menuitem").last().evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Home");
  assert.equal(await menu.getByRole("menuitem").first().evaluate((element) => element === document.activeElement), true);
  await menu.getByRole("menuitem").last().click();
  assert.equal(await input.inputValue(), "Alpha 剪贴 charlie");

  const textarea = page.locator('[data-fixture-editor="textarea"]');
  await page.evaluate(() => { window.fixtureClipboard = "第一行\n第二行"; });
  await textarea.evaluate((element) => {
    element.focus(); element.setSelectionRange(0, element.value.length);
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  await menu.getByRole("menuitem").last().click();
  assert.equal(await textarea.inputValue(), "第一行\n第二行");

  const editable = page.locator('[data-fixture-editor="contenteditable"]');
  await page.evaluate(() => { window.fixtureClipboard = "替换"; });
  await editable.locator("strong").evaluate((element) => {
    window.getSelection().selectAllChildren(element);
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  await menu.getByRole("menuitem").last().click();
  assert.equal(await editable.textContent(), "Editable 替换 sample");

  await input.evaluate((element) => {
    element.readOnly = true; element.focus(); element.setSelectionRange(0, 5);
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  await menu.waitFor();
  assert.equal(await menu.getByRole("menuitem").count(), 1);
  assert((await menu.textContent()).includes(labels.copy));
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await menu.count(), 0);
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);

  const plain = page.locator("[data-fixture-selection]");
  await plain.evaluate((element) => {
    // Opt into document selection, as production read-only text regions do.
    element.style.userSelect = "text";
    element.focus(); window.getSelection().selectAllChildren(element);
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  await menu.waitFor();
  assert.equal(await menu.getByRole("menuitem").count(), 1);
  await page.keyboard.press("Tab");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await menu.count(), 0);
  assert.equal(await plain.evaluate((element) => element === document.activeElement), true);
  const prevented = await plain.evaluate((element) => {
    window.getSelection().removeAllRanges(); element.focus();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(prevented, true, "empty desktop menus must not fall through to browser Inspect/Reload");
  assert.equal(await menu.count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS desktop: copy/paste only, controlled input/textarea/contenteditable paste, readonly copy, keyboard focus restoration, no empty or Inspect/Reload menus");
  await context.close();
} finally {
  await browser.close();
}
