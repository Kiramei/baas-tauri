// Real Header/Sidebar + store + execution policy; entirely synthetic browser data.
// Run against the isolated workspace fixture. No backend, native window or notification.
/* global window, document, CustomEvent, getComputedStyle, innerWidth */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.FIXTURE_ORIGIN || "http://127.0.0.1:8317";
const browser = await chromium.launch({ headless: true });
const results = [];
const errors = [];
const locales = process.env.PROFILE_STATUS_LOCALE
  ? [process.env.PROFILE_STATUS_LOCALE]
  : ["en", "zh", "de", "fr", "ja", "ko", "ru"];

async function update(page, patch) {
  await page.evaluate(
    (patch) =>
      window.dispatchEvent(
        new CustomEvent("fixture:profile-status", {
          detail: { configId: "alpha", patch },
        })
      ),
    patch
  );
}

async function state(page, expected) {
  await page.waitForFunction(
    (expected) =>
      document.querySelector("#tab-alpha")?.getAttribute("data-profile-run-state") === expected,
    expected
  );
}

try {
  if (process.env.ARTIFACT_DIR) await mkdir(process.env.ARTIFACT_DIR, { recursive: true });
  for (const locale of locales)
    for (const theme of ["light", "dark"])
      for (const mobile of [false, true]) {
        const labels = JSON.parse(
          await readFile(new URL(`../../public/locales/${locale}.json`, import.meta.url), "utf8")
        );
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
          reducedMotion: "reduce",
        });
        // Freeze each page's loaded modules while other agents edit the shared
        // checkout. The fixture also has no reason to open a backend socket.
        await context.routeWebSocket(/.*/, () => {});
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(
          `${origin}/tests/browser/workspace.html?runStatus=1&logs=1&lang=${locale}&theme=${theme}`,
          { waitUntil: "domcontentloaded" }
        );
        const row = page.locator("#tab-alpha");
        await row.waitFor();
        await page.mouse.move(0, 0);
        await state(page, "idle");
        assert.equal(
          await row.locator("[data-profile-run-indicator]:visible").count(),
          0,
          "historical ERROR log samples must not imply a failed run"
        );

        await update(page, { running: false, exit_code: 17 });
        await state(page, "failed");
        const failed = row.locator('[data-profile-run-indicator="failed"]:visible');
        assert.equal(await failed.count(), 1);
        assert.equal(await failed.getAttribute("aria-label"), labels.profile.runFailed);
        assert((await row.getAttribute("aria-label")).includes(labels.profile.runFailed));
        assert.equal(
          await failed.evaluate((element) => getComputedStyle(element).color),
          "rgb(226, 93, 90)"
        );
        assert.equal(await failed.locator(".animate-spin").count(), 0);
        const rowBox = await row.boundingBox(),
          iconBox = await failed.boundingBox();
        assert(
          iconBox.x > rowBox.x + rowBox.width / 2,
          "failure icon belongs in the right action slot"
        );
        assert.equal(
          await page.locator("#tab-beta [data-profile-run-indicator]:visible").count(),
          0,
          "a different profile must remain idle"
        );
        await page.locator("#tab-beta").click();
        await state(page, "failed");
        assert.equal(await row.getAttribute("aria-pressed"), "false");
        await row.click();
        await page.evaluate(() => document.activeElement?.blur());
        await page.mouse.move(0, 0);
        await failed.waitFor();
        await update(page, { timestamp: Date.now(), current_task: null });
        await state(page, "failed");
        if (process.env.ARTIFACT_DIR && locale === "zh")
          await page.screenshot({
            path: join(
              process.env.ARTIFACT_DIR,
              `failed-${theme}-${mobile ? "mobile" : "desktop"}.png`
            ),
            animations: "disabled",
          });

        const action = row.getByRole("button", { name: new RegExp(labels.profile.edit) });
        await action.focus();
        await page.getByRole("tooltip").filter({ hasText: labels.profile.runFailed }).waitFor();
        await action.click();
        await page.getByRole("menuitem", { name: labels.profile.copy, exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.evaluate(() => document.activeElement?.blur());
        await page.mouse.move(0, 0);
        await failed.waitFor();

        await update(page, { running: true, exit_code: 17 });
        await state(page, "running");
        const running = row.locator('[data-profile-run-indicator="running"]:visible');
        assert.equal(await running.count(), 1);
        assert.equal(await running.getAttribute("aria-label"), labels.profile.running);
        assert.equal(await row.locator('[data-profile-run-indicator="failed"]:visible').count(), 0);
        await update(page, { running: false });
        await state(page, "idle");
        assert.equal(await row.locator("[data-profile-run-indicator]:visible").count(), 0);

        await update(page, { running: true });
        await update(page, { running: false, exit_code: 130, _stopRequested: true });
        await state(page, "idle");
        await update(page, { running: true });
        await update(page, { running: false, exit_code: 23 });
        await state(page, "failed");
        assert.equal(
          await failed.count(),
          1,
          "a new failed run clears the prior manual-stop intent"
        );
        await update(page, { running: true });
        await update(page, { running: false, exit_code: 0 });
        await state(page, "idle");
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        results.push({
          locale,
          theme,
          mobile,
          failedOnRight: true,
          lifecycle: true,
          menuAndTooltip: true,
        });
        await context.close();
      }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      { cases: results.length, failures: 0, nativeOperations: false, results },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
