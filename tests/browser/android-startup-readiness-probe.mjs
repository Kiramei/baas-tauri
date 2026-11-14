// Run against an Android-mode Vite server. Every native IPC is mocked locally.
/* global window, structuredClone, CustomEvent */
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  window.__BAAS_MOCK_STARTUP__ = true;
  window.__STARTUP_REJECT_IPC__ = false;
  window.__STARTUP_STATUS__ = {
    bootstrap: {
      startedAt: 100,
      stage: "service",
      backendInstalled: true,
      resourcesReady: false,
      steps: [{ id: "service", state: "done" }],
    },
  };
  window.__TAURI_INTERNALS__ = {
    invoke: async (command) => {
      if (command !== "updater_get_startup_state")
        throw new Error(`Unexpected native command: ${command}`);
      if (window.__STARTUP_REJECT_IPC__) throw new Error("Synthetic temporary IPC failure");
      return structuredClone(window.__STARTUP_STATUS__);
    },
  };
});
const input = (initialized, cycle) =>
  page.evaluate(
    ({ initialized, cycle }) =>
      window.dispatchEvent(
        new CustomEvent("fixture:readiness-input", { detail: { initialized, cycle } })
      ),
    { initialized, cycle }
  );
const ready = (expected) => page.waitForSelector(`[data-startup-ready="${expected}"]`);
const completed = (startedAt) =>
  page.evaluate((startedAt) => {
    window.__STARTUP_STATUS__ = {
      bootstrap: {
        startedAt,
        stage: "ready",
        backendInstalled: true,
        resourcesReady: true,
        steps: ["service", "ocr", "resources"].map((id) => ({ id, state: "done" })),
      },
    };
  }, startedAt);
try {
  await page.goto(
    `${process.env.FIXTURE_ORIGIN || "http://127.0.0.1:8323"}/tests/browser/android-startup-readiness.html`,
    { waitUntil: "domcontentloaded" }
  );
  await ready(false);
  await input(true, 0);
  await page.waitForTimeout(650);
  assert.equal(
    await page.locator("output").getAttribute("data-startup-ready"),
    "false",
    "a listening socket alone cannot expose the application"
  );
  await completed(100);
  await ready(true);
  await input(false, 0);
  await ready(false);
  await input(true, 0);
  await ready(true);
  await input(true, 1);
  await ready(false);
  await page.waitForTimeout(650);
  assert.equal(
    await page.locator("output").getAttribute("data-startup-ready"),
    "false",
    "a new update cycle cannot reuse the old process status"
  );
  await completed(101);
  await ready(true);
  await input(true, 2);
  await ready(false);
  await page.evaluate(() => {
    window.__STARTUP_REJECT_IPC__ = true;
  });
  await completed(102);
  await page.waitForTimeout(650);
  assert.equal(await page.locator("output").getAttribute("data-startup-ready"), "false");
  await page.evaluate(() => {
    window.__STARTUP_REJECT_IPC__ = false;
    window.__STARTUP_STATUS__.bootstrap.error = "Synthetic OCR failure";
  });
  await page.waitForTimeout(650);
  assert.equal(
    await page.locator("output").getAttribute("data-startup-ready"),
    "false",
    "a stale true flag cannot hide a failed resource initializer"
  );
  await page.evaluate(() => {
    delete window.__STARTUP_STATUS__.bootstrap.error;
  });
  await ready(true);
  assert.deepEqual(errors, []);
  console.log(
    "PASS real React startup gate: listening-only, verified resources, reconnect, process-cycle freshness, transient IPC and failure recovery"
  );
} finally {
  await browser.close();
}
