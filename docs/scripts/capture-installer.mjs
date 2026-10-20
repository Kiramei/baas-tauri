import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const destination = path.join(root, "docs/public/media/desktop/installer-manifest.json");
const dictionaries = Object.fromEntries(
  ["en", "zh"].map((locale) => [
    locale,
    JSON.parse(readFileSync(path.join(root, "public/locales", locale + ".json"), "utf8")),
  ])
);
const locale = process.argv[4] || "en";
assert.ok(locale === "en" || locale === "zh");
const scenario = process.argv[3] || "failed";
assert.ok(scenario === "failed" || scenario === "completed");
const browser = await chromium.connectOverCDP("http://127.0.0.1:" + (process.argv[2] || "19235"));
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url() === "http://tauri.localhost/");
if (!page) throw new Error("Expected the isolated installer native WebView");
page.setDefaultTimeout(15000);
const manifest = existsSync(destination)
  ? JSON.parse(readFileSync(destination, "utf8"))
  : {
      sourceRevision: "be186c524ab9f7a91c41582aec3a5fef06614751",
      shots: [],
      verified: [],
    };
manifest.scope =
  "Native portable installer in a separate disposable directory. Failure deliberately removes the backend entrypoint with updates skipped. Completion reuses audited backend files and a custom preinstalled Python; fresh network/dependency installation remains untested. No task scheduler is started.";
manifest.executableSha256 = "f248bb598d2254526cc755707c499fff8b3d6c94dea892fc357ff4a0e9c020c0";
const text = (key, language = locale) => {
  const value = key.split(".").reduce((value, part) => value?.[part], dictionaries[language]);
  const result = typeof value === "object" ? value?.$self : value;
  if (typeof result !== "string") throw new Error("Unknown label: " + key);
  return result;
};
const button = (name) => page.getByRole("button", { name, exact: true }).filter({ visible: true });
const privateText =
  /[A-Za-z]:[\\/]|baas-shm-[a-f0-9-]+|\b(?:token|password|secret|cdk)\s*[=:]\s*\S+/i;
async function capture(state, preserveHover = false) {
  await page.evaluate(() => document.fonts.ready);
  if (!preserveHover) await page.mouse.move(1450, 45);
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains("light")),
    true
  );
  const file = `media/desktop/${locale}/installer-${state}.png`;
  mkdirSync(path.dirname(path.join(root, "docs/public", file)), { recursive: true });
  const privateFields = [
    page.getByRole("textbox", { name: text("label.installDir"), exact: true }),
    page.locator(".xterm-rows > div").filter({ hasText: privateText }),
    page.locator(".font-mono:not(:has(.terminal-host))").filter({ hasText: privateText }),
    page.locator("[role='dialog'] .leading-5").filter({ hasText: privateText }),
  ];
  try {
    for (const fields of privateFields)
      await fields.evaluateAll((elements) => {
        for (const element of elements) {
          if (element.hasAttribute("data-docs-private")) continue;
          element.setAttribute("data-docs-private", "");
          element.dataset.docsOriginalFilter = element.style.getPropertyValue("filter");
          element.dataset.docsOriginalPriority = element.style.getPropertyPriority("filter");
          element.style.setProperty("filter", "blur(12px)", "important");
          if (getComputedStyle(element).filter !== "blur(12px)")
            throw new Error("Privacy blur was overridden");
        }
      });
    await page.screenshot({ path: path.join(root, "docs/public", file) });
  } finally {
    await page.locator("[data-docs-private]").evaluateAll((elements) => {
      for (const element of elements) {
        element.style.setProperty(
          "filter",
          element.dataset.docsOriginalFilter || "",
          element.dataset.docsOriginalPriority || ""
        );
        delete element.dataset.docsOriginalFilter;
        delete element.dataset.docsOriginalPriority;
        element.removeAttribute("data-docs-private");
      }
    });
  }
  manifest.shots = manifest.shots.filter((shot) => shot.file !== file);
  manifest.shots.push({
    file,
    locale,
    state,
    native: true,
    theme: "light",
    portable: true,
    privacy:
      "Native capture applies a temporary 12px blur to the install-path input, terminal rows with local paths/IPC identifiers/credentials, matching structured-log rows and tooltip commands.",
  });
  console.log(locale + "/installer-" + state);
}
try {
  await page.setViewportSize({ width: 1600, height: 1000 });
  if (scenario === "failed") {
    const existingError = page.getByRole("dialog", { name: "Setup Error", exact: true });
    if (await existingError.count())
      await existingError.getByRole("button", { name: "Back to Setup", exact: true }).click();
    else if (await page.getByRole("dialog").count()) await page.keyboard.press("Escape");
    const advanced = page.locator(".install-preflight-advanced");
    const current = (await advanced.innerText()).includes(text("installer.advanced", "zh"))
      ? "zh"
      : "en";
    await advanced.click();
    if (current !== locale) {
      await page.getByRole("combobox", { name: text("language", current), exact: true }).click();
      await page
        .getByRole("option", {
          name: text("language." + (locale === "zh" ? "chinese" : "english"), current),
          exact: true,
        })
        .click();
    }
    await button(text("common.theme.light")).click();
    const autoEnter = page.getByRole("switch", { name: text("installer.autoEnter"), exact: true });
    if (await autoEnter.isChecked()) await autoEnter.click();
    await capture("advanced");
    const transport = page.getByRole("dialog").getByRole("combobox").nth(2);
    await transport.click();
    await capture("transport-options");
    await page.keyboard.press("Escape");
    await button(text("common.cancel")).click();
    assert.ok(
      await page
        .getByRole("textbox", { name: text("label.installDir"), exact: true })
        .evaluate((element) => element.readOnly)
    );
    await capture("preflight");
    await button(text("installer.start")).click();
    const failure = page.getByRole("dialog", { name: "Setup Error", exact: true });
    await failure.waitFor();
    assert.ok((await failure.innerText()).includes("missing main.service.py --shm-name support"));
    await capture("error");
    await failure.getByRole("button", { name: text("common.close"), exact: true }).click();
    const failedNode = button("Launch Backend: failed");
    await failedNode.hover();
    await page.getByRole("tooltip").waitFor();
    await capture("node-details", true);
    await page.keyboard.press("Escape");
    await button(text("installer.start")).waitFor();
    manifest.verified = manifest.verified.filter(
      (check) => check.locale !== locale || check.scenario !== scenario
    );
    manifest.verified.push({
      locale,
      scenario,
      check:
        "portable read-only directory, advanced controls, real missing-entrypoint failure, node tooltip, Escape cancellation returns to setup after dismissing the error dialog",
      passed: true,
    });
  } else {
    await page.locator('[data-installer-phase="completed"]').waitFor({ timeout: 60000 });
    await button(text("installer.enter")).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "Setup Error" }).count(), 0);
    await capture("completed");
    await button("Launch Backend: success").hover();
    await page.getByRole("tooltip").waitFor();
    await capture("completed-details", true);
    manifest.verified = manifest.verified.filter(
      (check) => check.locale !== locale || check.scenario !== scenario
    );
    manifest.verified.push({
      locale,
      scenario,
      check:
        "real managed backend ready; automatic entry off retains logs; custom Python and existing code reused",
      passed: true,
    });
  }
  manifest.capturedAt = new Date().toISOString();
  manifest.shots.sort((left, right) => left.file.localeCompare(right.file));
  manifest.verified.sort((left, right) =>
    (left.locale + left.scenario).localeCompare(right.locale + right.scenario)
  );
  writeFileSync(destination, JSON.stringify(manifest, null, 2) + "\n");
} finally {
  await browser.close();
}
