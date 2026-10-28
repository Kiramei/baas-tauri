import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureTarget } from "./capture-target.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const target = captureTarget(root);
const base = JSON.parse(readFileSync(path.join(root, "docs/public/media/desktop/manifest.json")));
const dictionaries = Object.fromEntries(
  ["en", "zh"].map((locale) => [
    locale,
    JSON.parse(readFileSync(path.join(root, "public/locales", locale + ".json"), "utf8")),
  ])
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:" + (process.argv[2] || "19230"));
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url() === "http://tauri.localhost/");
if (!page) throw new Error("Expected the isolated native release WebView");
page.setDefaultTimeout(10000);
let locale = (await page
  .getByRole("button", { name: dictionaries.zh.nav.settings, exact: true })
  .filter({ visible: true })
  .count())
  ? "zh"
  : "en";
const t = (key) => {
  const value = key.split(".").reduce((value, part) => value?.[part], dictionaries[locale]);
  const text = typeof value === "object" ? value?.$self : value;
  if (typeof text !== "string") throw new Error("Unknown label: " + locale + ":" + key);
  return text;
};
const button = (name) => page.getByRole("button", { name, exact: true }).filter({ visible: true });
const shots = [];
const verified = [];
async function settings(section) {
  await button(t("nav.settings")).click();
  await page
    .getByRole("navigation", { name: t("settings.categories"), exact: true })
    .getByRole("button", { name: t("settings.sections." + section), exact: true })
    .click();
}
async function capture(state) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1400, 45);
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains("dark")),
    target.theme === "dark"
  );
  const file = "media/desktop/" + locale + "/details-" + state + ".png";
  const destination = path.join(target.publicRoot, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  await page.screenshot({ path: destination });
  shots.push({ file, locale, state, theme: target.theme, native: true });
  console.log(locale + "/" + state);
}
async function profileMenu() {
  await button(t("nav.home")).click();
  await button(t("profile.edit") + " Schale Demo").click();
  await page.getByRole("menu", { name: "Schale Demo", exact: true }).waitFor();
}
try {
  await target.verify(page);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: /^Schale Demo / })
    .filter({ visible: true })
    .click();
  for (const nextLocale of ["en", "zh"]) {
    await settings("general");
    if (locale !== nextLocale) {
      await page.getByRole("combobox", { name: t("language"), exact: true }).click();
      await page
        .getByRole("option", {
          name: t("language." + (nextLocale === "zh" ? "chinese" : "english")),
          exact: true,
        })
        .click();
      locale = nextLocale;
    }
    await settings("appearance");
    await page
      .getByRole("group", { name: t("common.theme"), exact: true })
      .getByRole("button", { name: t(`common.theme.${target.theme}`), exact: true })
      .click();
    const assets = page.getByRole("switch", { name: t("settings.ui.assets"), exact: true });
    if ((await assets.getAttribute("aria-checked")) === "true") await assets.click();
    await button(t("nav.home")).click();
    assert.equal(await button(t("common.stop")).count(), 0, "Capture profile must not be running");
    await capture("home");
    await button(t("task.overview")).click();
    await capture("task-overview");
    await page.keyboard.press("Escape");
    await profileMenu();
    await capture("profile-menu");
    await page
      .getByRole("menu", { name: "Schale Demo", exact: true })
      .getByRole("menuitem", { name: t("common.edit"), exact: true })
      .click();
    assert.equal(await page.getByRole("dialog").getByRole("combobox").isDisabled(), true);
    await capture("profile-edit");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: t("common.cancel"), exact: true })
      .click();
    await button(t("profile.add")).click();
    await capture("profile-create");
    await page.getByRole("dialog").getByRole("textbox").fill("");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: t("common.create"), exact: true })
      .click();
    await page.getByRole("alert").waitFor();
    await capture("profile-required");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: t("common.cancel"), exact: true })
      .click();
    await profileMenu();
    await page.getByRole("menuitem", { name: t("common.delete"), exact: true }).click();
    await page.getByRole("alertdialog").waitFor();
    await capture("profile-delete-confirmation");
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: t("common.cancel"), exact: true })
      .click();
    verified.push({
      locale,
      check: "profile server locked, empty-name error, delete confirmation cancelled",
      passed: true,
    });

    await settings("appearance");
    await button(t("settings.ui.themeColor")).click();
    await capture("theme-color");
    await page.keyboard.press("Escape");
    await settings("runtime");
    await page.getByRole("combobox", { name: t("transport.label"), exact: true }).click();
    await capture("transport-options");
    await page.keyboard.press("Escape");

    await settings("shortcuts");
    const undo = page.getByRole("group", { name: t("edit.undo"), exact: true });
    const original = await undo.getByRole("textbox").inputValue();
    await undo.getByRole("button", { name: t("settings.shortcuts.record"), exact: true }).click();
    await capture("shortcut-recording");
    await page.keyboard.press("Escape");
    assert.equal(await undo.getByRole("textbox").inputValue(), original);
    await undo.getByRole("button", { name: t("settings.shortcuts.record"), exact: true }).click();
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(250);
    assert.equal(await undo.getByRole("textbox").inputValue(), original);
    await capture("shortcut-conflict");
    verified.push({
      locale,
      check: "Escape cancels shortcut recording; reserved Copy rejected without replacing Undo",
      passed: true,
    });
    await button(t("common.edit")).click();
    await capture("global-shortcuts");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: t("common.cancel"), exact: true })
      .click();

    await settings("logs");
    await button(t("settings.systemLogs.open")).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByPlaceholder(t("settings.systemLogs.search"), { exact: true })
      .fill("Frontend system logging initialized");
    await page.waitForTimeout(500);
    await capture("system-logs-filtered");
    const rows = dialog.locator(".system-log-entry");
    if (await rows.count()) {
      await rows.last().locator("summary").click();
      await capture("system-log-details");
    }
    await dialog.getByRole("button", { name: t("settings.systemLogs.clear"), exact: true }).click();
    await capture("system-logs-clear-confirmation");
    await dialog.getByRole("button", { name: t("common.cancel"), exact: true }).click();
    await dialog.getByRole("button", { name: t("common.close"), exact: true }).click();
    verified.push({
      locale,
      check: "system-log filtering and clear confirmation cancellation; no logs cleared",
      passed: true,
    });
  }
  const evidence = {
    capturedAt: new Date().toISOString(),
    sourceRevision: base.sourceRevision,
    mode: `Isolated real native desktop release and real backend; ${target.theme} mode; Schale Demo scheduler stopped`,
    scope:
      "Read-only dialogs plus rejected/cancelled UI input. No profiles created/deleted, no logs cleared, no task execution or updater applied.",
    verified,
    shots,
  };
  writeFileSync(
    path.join(target.publicRoot, "media/desktop/workspaces-manifest.json"),
    JSON.stringify(evidence, null, 2) + "\n"
  );
} finally {
  await browser.close();
}
