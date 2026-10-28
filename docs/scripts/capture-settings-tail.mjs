import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureTarget } from "./capture-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const target = captureTarget(root);
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] || "19240"}`);
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url() === "http://tauri.localhost/");
assert.ok(page);
const dictionaries = Object.fromEntries(["en", "zh"].map(locale => [locale, JSON.parse(readFileSync(path.join(root, `public/locales/${locale}.json`)))]));
let locale = await page.getByRole("button", { name: dictionaries.zh.nav.settings, exact: true }).filter({ visible: true }).count() ? "zh" : "en";
const t = key => key.split(".").reduce((value, part) => value[part], dictionaries[locale]);
const button = name => page.getByRole("button", { name, exact: true }).filter({ visible: true });
const shots = [];
async function settings(section) {
  await button(t("nav.settings")).click();
  await page.getByRole("navigation", { name: t("settings.categories"), exact: true }).getByRole("button", { name: t(`settings.sections.${section}`), exact: true }).click();
}
try {
  await target.verify(page);
  await settings("general");
  if (locale !== "en") {
    await page.getByRole("combobox", { name: t("language").$self, exact: true }).click();
    await page.getByRole("option", { name: t("language.english"), exact: true }).click();
    locale = "en";
  }
  await settings("appearance");
  await page.getByRole("group", { name: t("common.theme").$self, exact: true }).getByRole("button", { name: t(`common.theme.${target.theme}`), exact: true }).click();
  for (const section of ["shortcuts", "updates"]) {
    await settings(section);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    const panel = page.locator(".settings-page").filter({ visible: true });
    assert.equal(await panel.count(), 1);
    for (let index = 2; index <= 4; index++) {
      const moved = await panel.evaluate(element => {
        const scroller = element.closest(".app-page-scroll");
        if (!scroller) throw new Error("Missing settings scroll owner");
        const before = scroller.scrollTop;
        scroller.scrollTop += scroller.clientHeight * 0.85;
        return scroller.scrollTop > before + 2;
      });
      if (!moved) break;
      await page.waitForTimeout(300);
      assert.ok(await page.evaluate(theme => document.documentElement.classList.contains(theme), target.theme));
      const file = `media/desktop/en/settings-${section}-scroll-${index}.png`;
      mkdirSync(path.dirname(path.join(target.publicRoot, file)), { recursive: true });
      await page.screenshot({ path: path.join(target.publicRoot, file) });
      shots.push({ file, locale: "en", state: `settings-${section}-scroll-${index}`, theme: target.theme, native: true });
    }
  }
  assert.ok(shots.some(shot => shot.state === "settings-updates-scroll-2"));
  writeFileSync(path.join(target.publicRoot, "media/desktop/settings-tail-manifest.json"), JSON.stringify({ capturedAt: new Date().toISOString(), sourceRevision: target.sourceRevision, shots }, null, 2) + "\n");
  console.log(JSON.stringify({ captured: shots.length }));
} finally { await browser.close(); }
