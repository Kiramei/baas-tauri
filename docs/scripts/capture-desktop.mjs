import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIGURATION_SECTIONS } from "../../src/shared/ConfigurationSections.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] || "19230"}`);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url() === "http://tauri.localhost/");
if (!page) throw new Error("Expected the isolated native BAAS window");
page.setDefaultTimeout(10000);
const dictionaries = Object.fromEntries(
  ["en", "zh"].map((lang) => [
    lang,
    JSON.parse(readFileSync(path.join(repo, `public/locales/${lang}.json`), "utf8")),
  ])
);
let locale = (await page
  .getByRole("button", { name: dictionaries.zh.nav.settings, exact: true })
  .filter({ visible: true })
  .count())
  ? "zh"
  : "en";
const t = (key) => {
  const value = key.split(".").reduce((value, part) => value?.[part], dictionaries[locale]);
  const text = typeof value === "object" ? value?.$self : value;
  if (typeof text !== "string") throw new Error(`Unknown translation: ${locale}:${key}`);
  return text;
};
const shots = [];
const controls = [];
async function capture(name) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1100, 42);
  await page.waitForTimeout(350);
  if (await page.evaluate(() => document.documentElement.classList.contains("dark")))
    throw new Error("Documentation app captures must use light mode");
  const relative = `media/desktop/${locale}/${name}.png`;
  const destination = path.join(repo, "docs/public", relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  await page.screenshot({ path: destination });
  shots.push({
    file: relative,
    locale,
    state: name,
    theme: "light",
    native: true,
    width: await page.evaluate(() => innerWidth),
    height: await page.evaluate(() => innerHeight),
  });
  controls.push({
    locale,
    state: name,
    rows: await page
      .locator(".settings-row")
      .evaluateAll((rows) =>
        rows
          .filter((row) => row.getClientRects().length)
          .map((row) => ({
            label: row.querySelector(".settings-label")?.textContent?.trim() || "",
            description: row.querySelector(".settings-description")?.textContent?.trim() || "",
            controls: Array.from(row.querySelectorAll("input,textarea,button[role],select")).map(
              (control) => ({
                tag: control.tagName.toLowerCase(),
                role: control.getAttribute("role"),
                type: control.getAttribute("type"),
                min: control.getAttribute("min"),
                max: control.getAttribute("max"),
                step: control.getAttribute("step"),
                disabled: control.hasAttribute("disabled"),
              })
            ),
          }))
      ),
  });
  console.log(`${locale}/${name}`);
}
async function capturePanel(name) {
  await capture(name);
  const scroller = page.locator(".app-page-scroll").filter({ visible: true });
  if ((await scroller.count()) !== 1) return;
  for (let screen = 2; screen < 12; screen++) {
    const moved = await scroller.evaluate((element) => {
      const before = element.scrollTop;
      element.scrollTop += element.clientHeight * 0.85;
      return element.scrollTop > before + 2;
    });
    if (!moved) break;
    await capture(`${name}-scroll-${screen}`);
  }
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
}
async function settings(section) {
  await page
    .getByRole("button", { name: t("nav.settings"), exact: true })
    .filter({ visible: true })
    .click();
  await page
    .getByRole("navigation", { name: t("settings.categories"), exact: true })
    .getByRole("button", { name: t(`settings.sections.${section}`), exact: true })
    .click();
}
try {
  await page.getByRole("button", { name: /^Schale Demo / }).click();
  for (const nextLocale of ["en", "zh"]) {
    await settings("general");
    if (locale !== nextLocale) {
      await page.getByRole("combobox", { name: t("language"), exact: true }).click();
      await page
        .getByRole("option", {
          name: t(`language.${nextLocale === "zh" ? "chinese" : "english"}`),
          exact: true,
        })
        .click();
      locale = nextLocale;
      await page
        .getByRole("heading", { name: t("settings.sections.general"), exact: true })
        .waitFor();
    }
    await settings("appearance");
    await page
      .getByRole("group", { name: t("common.theme"), exact: true })
      .getByRole("button", { name: t("common.theme.light"), exact: true })
      .click();
    await page
      .getByRole("button", { name: t("nav.home"), exact: true })
      .filter({ visible: true })
      .click();
    await capture("workspace");
    await page
      .getByRole("button", { name: t("nav.configuration"), exact: true })
      .filter({ visible: true })
      .click();
    for (const section of CONFIGURATION_SECTIONS) {
      await page
        .getByRole("navigation", { name: t("configuration.categories"), exact: true })
        .getByRole("button", { name: t(section.title), exact: true })
        .click();
      await page.locator(".configuration-detail-heading").waitFor();
      const tabs = page.locator(".configuration-detail").getByRole("tab").filter({ visible: true });
      const count = await tabs.count();
      if (count > 0) await tabs.first().click();
      await capturePanel(`config-${section.id}`);
      for (let index = 1; index < count; index++) {
        await tabs.nth(index).click();
        await capturePanel(`config-${section.id}-tab-${index + 1}`);
      }
    }
    for (const section of ["general", "appearance", "shortcuts", "runtime", "updates", "logs"]) {
      await settings(section);
      await capturePanel(`settings-${section}`);
    }
    await page
      .getByRole("button", { name: t("nav.scheduler"), exact: true })
      .filter({ visible: true })
      .click();
    await capture("scheduler-list");
    await page.getByRole("button", { name: t("workflow.showGraph"), exact: true }).click();
    await page.locator(".react-flow__node").first().waitFor();
    await capture("scheduler-workflow");
    await page.keyboard.press("Escape");
  }
  const manifest = {
    capturedAt: new Date().toISOString(),
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    mode: "Native Tauri release build with isolated real backend; demo profiles; all demo tasks disabled. UI inspection does not prove game-task execution.",
    shots,
  };
  writeFileSync(
    path.join(repo, "docs/public/media/desktop/manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  mkdirSync(path.join(repo, "docs/evidence"), { recursive: true });
  writeFileSync(
    path.join(repo, "docs/evidence/desktop-controls.json"),
    `${JSON.stringify({ sourceRevision: manifest.sourceRevision, capturedAt: manifest.capturedAt, note: "Observed control labels/descriptions and HTML constraints; conditional options and behavior still require source review.", controls }, null, 2)}\n`
  );
} finally {
  await browser.close();
}
