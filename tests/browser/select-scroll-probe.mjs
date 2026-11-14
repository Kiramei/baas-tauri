// Real Config/FormSelect and trusted Chromium touch input; no backend or device.
/* global window, document, Element */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const android = process.env.ANDROID_FIXTURE_ORIGIN || "http://127.0.0.1:8337";
const webui = process.env.WEBUI_FIXTURE_ORIGIN || "http://127.0.0.1:8338";
const browser = await chromium.launch({ headless: true });
const results = [];

async function openConfig(context, origin, theme) {
  await context.routeWebSocket(/.*/, () => {});
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.stack);
  });
  await page.goto(`${origin}/tests/browser/workspace.html?configuration=1&lang=en&theme=${theme}`);
  await page
    .locator("nav")
    .getByRole("button", { name: "Configuration", exact: true })
    .last()
    .click();
  const trigger = page.locator(".configuration-compact-navigation [role='combobox']");
  await trigger.click();
  const viewport = page.locator("[data-radix-select-viewport]");
  await viewport.waitFor();
  await page.waitForTimeout(180);
  return { page, trigger, viewport, errors };
}

async function observe(page) {
  await page.evaluate(() => {
    window.__selectScrollCalls = 0;
    window.__selectTouchTypes = [];
    const original = Element.prototype.scrollIntoView;
    if (!window.__selectScrollOriginal) window.__selectScrollOriginal = original;
    Element.prototype.scrollIntoView = function (...args) {
      if (this.matches?.("[data-slot='select-item']")) window.__selectScrollCalls++;
      return window.__selectScrollOriginal.apply(this, args);
    };
    document.addEventListener(
      "pointerdown",
      (event) => window.__selectTouchTypes.push(event.pointerType),
      { once: true }
    );
  });
}

async function measure(viewport) {
  return viewport.evaluate((node) => ({
    top: node.scrollTop,
    height: node.clientHeight,
    max: node.scrollHeight - node.clientHeight,
    firstY: node.querySelector("[data-slot='select-item']").getBoundingClientRect().y,
    scale: node.getBoundingClientRect().height / node.clientHeight,
  }));
}

async function pan(page, viewport, distance, indicator = false) {
  await observe(page);
  const before = await measure(viewport);
  const bounds = await viewport.boundingBox();
  const x = bounds.x + bounds.width / 2;
  const y = indicator ? bounds.y + bounds.height - 12 : bounds.y + bounds.height / 2;
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  if (indicator) {
    await page.waitForTimeout(180);
    assert.equal(
      (await measure(viewport)).top,
      before.top,
      "Touch hold must not start hover scrolling"
    );
  }
  for (let step = 1; step <= 8; step++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + (distance * step) / 8 }],
    });
    await page.waitForTimeout(40);
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(180);
  await session.detach();
  const after = await measure(viewport);
  const trace = await page.evaluate(() => ({
    calls: window.__selectScrollCalls,
    types: window.__selectTouchTypes,
  }));
  assert(trace.types.includes("touch"), "Regression must use trusted touch pointers");
  assert.equal(
    trace.calls,
    0,
    "Overflow indicator changes must not scroll the focused item into view"
  );
  assert.equal(after.height, before.height, "Indicators must not resize the viewport");
  assert(
    Math.abs(after.top - before.top) > 1 &&
      Math.abs(after.top - before.top) <= Math.abs(distance) + 2
  );
  assert(
    Math.abs(after.firstY - before.firstY + (after.top - before.top) * before.scale) < 2,
    "Visible rows must move only by the native scroll delta"
  );
  await page.waitForTimeout(150);
  assert(
    Math.abs((await measure(viewport)).top - after.top) <= 1,
    "No hover timer may keep scrolling after touch release"
  );
  return {
    before: before.top,
    after: after.top,
    viewportHeight: after.height,
    focusedItemScrollCalls: trace.calls,
  };
}

try {
  for (const [name, origin, theme, viewportSize, hasTouch, forceIndicatorHit] of [
    ["android-touch", android, "light", { width: 392, height: 822 }, true, false],
    ["android-indicator-touch", android, "dark", { width: 392, height: 640 }, true, true],
    ["webui-hybrid-touch", webui, "light", { width: 800, height: 480 }, false, false],
  ]) {
    const context = await browser.newContext({
      viewport: viewportSize,
      hasTouch,
      isMobile: hasTouch,
    });
    try {
      const { page, trigger, viewport, errors } = await openConfig(context, origin, theme);
      if (forceIndicatorHit)
        await page.addStyleTag({
          content: ".select-surface-scroll-indicator { pointer-events: auto !important; }",
        });
      const media = await page.evaluate(() => ({
        hover: window.matchMedia("(hover: hover)").matches,
        coarse: window.matchMedia("(pointer: coarse)").matches,
      }));
      await page.locator("[data-slot='select-scroll-down-button']").waitFor();
      assert.equal(await page.locator("[data-slot='select-scroll-up-button']").count(), 0);
      const firstPan = await pan(page, viewport, -40, forceIndicatorHit || media.hover);
      await page.locator("[data-slot='select-scroll-up-button']").waitFor();
      const secondPan = await pan(page, viewport, -40, true);
      const lastLabel = (await page.getByRole("option").last().innerText()).trim();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await viewport.waitFor({ state: "detached" });
      assert((await trigger.innerText()).includes(lastLabel));
      await trigger.click();
      await viewport.waitFor();
      await page.waitForTimeout(180);
      assert.equal(await page.locator("[data-slot='select-scroll-down-button']").count(), 0);
      const reversePan = await pan(page, viewport, 40);
      await page.locator("[data-slot='select-scroll-down-button']").waitFor();
      await page.keyboard.press("Home");
      await page.keyboard.press("Enter");
      await viewport.waitFor({ state: "detached" });
      assert.deepEqual(errors, []);
      results.push({
        name,
        media,
        firstPan,
        secondPan,
        reversePan,
        lastValueSelectedWithKeyboard: true,
      });
    } finally {
      await context.close();
    }
  }
  const context = await browser.newContext({ viewport: { width: 800, height: 480 } });
  try {
    const { page, viewport, errors } = await openConfig(context, webui, "dark");
    const initial = await measure(viewport);
    await page.locator("[data-slot='select-scroll-down-button']").hover();
    await page.waitForTimeout(220);
    await page.mouse.move(2, 2);
    const hovered = await measure(viewport);
    assert(hovered.top > initial.top, "Mouse hover scrolling remains available");
    await page.waitForTimeout(200);
    assert.equal(
      (await measure(viewport)).top,
      hovered.top,
      "Mouse hover timer stops when leaving the indicator"
    );
    assert.equal(hovered.height, initial.height);
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    assert.deepEqual(errors, []);
    results.push({
      name: "webui-mouse",
      before: initial.top,
      after: hovered.top,
      viewportHeight: hovered.height,
    });
  } finally {
    await context.close();
  }
  if (process.env.SELECT_SCROLL_RESULTS)
    await writeFile(process.env.SELECT_SCROLL_RESULTS, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally {
  await browser.close();
}
