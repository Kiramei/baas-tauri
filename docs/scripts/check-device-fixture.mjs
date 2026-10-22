import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installDeviceFixture } from "./device-benchmark-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, ".cache/docs-benchmarks");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 480, height: 854 },
    deviceScaleFactor: 1.5,
  });
  await page.setContent('<button id="underlay">Underlying app</button>');
  await page.evaluate(() => {
    window.__underlayEvents = 0;
    document.body.addEventListener("click", () => window.__underlayEvents++);
  });
  await page.evaluate(installDeviceFixture, { owner: "fixture-test" });
  await page.evaluate(() => window.__docsDeviceFixture.setToken(259));
  assert.equal(await page.evaluate(() => window.__docsDeviceFixture.state().token), 259);
  await page.evaluate(() => {
    const canvas = document.querySelector("#docs-device-benchmark-fixture");
    for (const type of ["pointerdown", "pointerup"])
      canvas.dispatchEvent(
        new PointerEvent(type, { clientX: 240, clientY: 320, pointerId: 7, bubbles: true })
      );
  });
  assert.equal(await page.evaluate(() => window.__docsDeviceFixture.state().taps), 0);
  await page.mouse.click(240, 320);
  const state = await page.evaluate(() => window.__docsDeviceFixture.state());
  assert.equal(state.taps, 1);
  assert.equal(state.lastGesture.type, "mouse");
  await page.mouse.click(10, 220);
  assert.equal(await page.evaluate(() => window.__docsDeviceFixture.state().taps), 1);
  assert.equal(await page.evaluate(() => window.__underlayEvents), 0);
  await assert.rejects(
    page.evaluate(installDeviceFixture, { owner: "other-test" }),
    /already installed/
  );
  await assert.rejects(
    page.evaluate(() => window.__docsDeviceFixture.setToken(-1)),
    /Invalid fixture token/
  );
  await page.screenshot({ path: path.join(output, "device-fixture-test.png") });
  await page.evaluate(() => window.__docsDeviceFixture.remove());
  assert.equal(await page.locator("#docs-device-benchmark-fixture").count(), 0);
  await page.getByRole("button", { name: "Underlying app", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__underlayEvents), 1);
  const result = {
    checkedAt: new Date().toISOString(),
    scope:
      "Desktop browser unit/integration test of the benchmark fixture, not a real Android input measurement",
    viewport: { width: 480, height: 854, dpr: 1.5 },
    checks: [
      "token update",
      "untrusted input rejected",
      "trusted pointer counted",
      "target bounds",
      "underlay isolation",
      "reentry rejected",
      "invalid token rejected",
      "removal and underlay restoration",
    ],
    passed: true,
  };
  writeFileSync(
    path.join(output, "device-fixture-validation.json"),
    JSON.stringify(result, null, 2) + "\n"
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
