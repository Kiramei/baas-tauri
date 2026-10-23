import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureTarget } from "./capture-target.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const target = captureTarget(repo);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] || "19230"}`);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url() === "http://tauri.localhost/");
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
  return typeof value === "object" ? value?.$self : value;
};
const results = [];
try {
  await target.verify(page);
  for (const next of ["en", "zh"]) {
    await page
      .getByRole("button", { name: t("nav.settings"), exact: true })
      .filter({ visible: true })
      .click();
    await page
      .getByRole("navigation", { name: t("settings.categories"), exact: true })
      .getByRole("button", { name: t("settings.sections.general"), exact: true })
      .click();
    if (locale !== next) {
      await page.getByRole("combobox", { name: t("language"), exact: true }).click();
      await page
        .getByRole("option", {
          name: t(`language.${next === "zh" ? "chinese" : "english"}`),
          exact: true,
        })
        .click();
      locale = next;
    }
    await page
      .getByRole("navigation", { name: t("settings.categories"), exact: true })
      .getByRole("button", { name: t("settings.sections.appearance"), exact: true })
      .click();
    const assets = page.getByRole("switch", { name: t("settings.ui.assets"), exact: true });
    if ((await assets.getAttribute("aria-checked")) === "true") await assets.click();
    await page.getByRole("group", { name: t("common.theme"), exact: true })
      .getByRole("button", { name: t(`common.theme.${target.theme}`), exact: true }).click();
    if (!(await page.evaluate(theme => document.documentElement.classList.contains(theme), target.theme)))
      throw new Error("Unexpected application capture theme");
    await page
      .getByRole("button", { name: t("nav.home"), exact: true })
      .filter({ visible: true })
      .click();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(target.publicRoot, `media/desktop/${locale}/workspace.png`),
    });
    await page
      .getByRole("button", { name: t("nav.configuration"), exact: true })
      .filter({ visible: true })
      .click();
    await page
      .getByRole("navigation", { name: t("configuration.categories"), exact: true })
      .getByRole("button", { name: t("cafe"), exact: true })
      .click();
    await page.locator(".configuration-detail").getByRole("tab").first().click();
    await page
      .locator(".app-page-scroll")
      .filter({ visible: true })
      .evaluate((element) => {
        element.scrollTop = 0;
      });
    const control = page.getByRole("switch", { name: t("cafe.collectReward"), exact: true });
    const initial = await control.getAttribute("aria-checked");
    const frames = path.join(repo, `.cache/docs-gif/${locale}`);
    mkdirSync(frames, { recursive: true });
    let index = 0;
    const record = async (count) => {
      for (let frame = 0; frame < count; frame++) {
        await page.screenshot({
          path: path.join(frames, `${String(index++).padStart(3, "0")}.png`),
        });
        await page.waitForTimeout(100);
      }
    };
    await page.mouse.move(800, 120);
    await record(5);
    await control.click();
    await page.mouse.move(800, 120);
    await record(10);
    await page
      .getByRole("group", { name: t("configuration.history"), exact: true })
      .getByRole("button", { name: t("edit.undo"), exact: true })
      .click();
    await page.mouse.move(800, 120);
    await record(10);
    if ((await control.getAttribute("aria-checked")) !== initial)
      throw new Error("Undo did not restore the captured value");
    const output = path.join(target.publicRoot, `media/desktop/${locale}/configuration-undo.gif`);
    execFileSync(
      process.env.DOCS_PYTHON || "python",
      ["docs/scripts/encode-demo.py", frames, output],
      { cwd: repo, windowsHide: true }
    );
    results.push({
      file: `media/desktop/${locale}/configuration-undo.gif`,
      locale,
      native: true,
      theme: target.theme,
      runtimeOverviewAssetsShown: false,
      actions: [
        "toggle collect rewards",
        "wait for automatic commit",
        "undo",
        "verify original value restored",
      ],
      gameInputSent: false,
    });
    console.log(`${locale}: GIF recorded`);
  }
  writeFileSync(
    path.join(target.evidenceRoot, "recordings.json"),
    `${JSON.stringify({ recordedAt: new Date().toISOString(), results }, null, 2)}\n`
  );
} finally {
  await browser.close();
}
