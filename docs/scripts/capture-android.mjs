import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIGURATION_SECTIONS } from "../../src/shared/ConfigurationSections.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] || "19231"}`, {
  noDefaults: true,
});
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url() === "http://tauri.localhost/");
if (!page) throw new Error("Expected the Android native WebView");
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
async function settings(section) {
  await page
    .getByRole("button", { name: t("nav.settings"), exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("combobox", { name: t("settings.categories"), exact: true }).click();
  await page.getByRole("option", { name: t(`settings.sections.${section}`), exact: true }).click();
}
const shots = [];
async function capture(name) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  if (await page.evaluate(() => document.documentElement.classList.contains("dark")))
    throw new Error("Expected light theme");
  const relative = `media/android/${locale}/${name}.png`;
  const destination = path.join(repo, "docs/public", relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  await page.screenshot({ path: destination });
  shots.push({ file: relative, locale, state: name, native: true, theme: "light" });
  console.log(`${locale}/${name}`);
}
try {
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: t("nav.configuration"), exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("combobox", { name: t("configuration.categories"), exact: true }).click();
  await page.getByRole("option", { name: t("cafe"), exact: true }).click();
  const name = await page
    .locator(".configuration-detail-heading")
    .filter({ visible: true })
    .innerText();
  if (!name.includes("Documentation Demo"))
    throw new Error("Select the isolated Documentation Demo profile first");
  const rewards = page.getByRole("switch", { name: t("cafe.collectReward"), exact: true });
  const original = await rewards.getAttribute("aria-checked");
  await rewards.click();
  await page.waitForTimeout(600);
  await page.reload();
  await page
    .getByRole("button", { name: t("nav.configuration"), exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("combobox", { name: t("configuration.categories"), exact: true }).click();
  await page.getByRole("option", { name: t("cafe"), exact: true }).click();
  if ((await rewards.getAttribute("aria-checked")) === original)
    throw new Error("Configuration did not survive WebView reload");
  await rewards.click();
  await page.waitForTimeout(600);
  console.log("Verified native Android configuration persistence and restored the demo value");
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
    await capture("home");
    await page
      .getByRole("button", { name: t("nav.configuration"), exact: true })
      .filter({ visible: true })
      .click();
    for (const section of CONFIGURATION_SECTIONS.filter((section) => section.id !== "emulator")) {
      await page
        .getByRole("combobox", { name: t("configuration.categories"), exact: true })
        .click();
      await page.getByRole("option", { name: t(section.title), exact: true }).click();
      await capture(`config-${section.id}`);
    }
    for (const section of ["general", "appearance", "shortcuts", "runtime", "updates", "logs"]) {
      await settings(section);
      await capture(`settings-${section}`);
    }
    await page
      .getByRole("button", { name: t("nav.scheduler"), exact: true })
      .filter({ visible: true })
      .click();
    await capture("scheduler");
  }
  writeFileSync(
    path.join(repo, "docs/public/media/android/manifest.json"),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), device: "MuMu Android emulator, 720x1280", applicationId: "io.github.kiramei.baas_tauri.dev", apkSha256: "94E0565429B262C83762ABCF7B303CA0380577DBAD8CB45B4FD5751964D8E578", expectedSourceRevision: "5ca0ac7ca88ec8523d17bfbd9aca0750d8ba7d78", provenance: "Existing arm64Debug artifact in clean android-dev worktree; not rebuilt in this documentation pass. Native installed WebView captures, no synthetic frontend fixture.", verified: ["ARM64 APK installation", "cold launch and backend health", "configuration edit persisted across WebView reload, original demo value restored", "navigation", "language/theme switches"], notYetVerified: ["game task execution", "fresh build provenance"], shots }, null, 2)}\n`
  );
} finally {
  await browser.close();
}
