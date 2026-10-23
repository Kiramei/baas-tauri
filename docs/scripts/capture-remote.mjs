import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
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
page.setDefaultTimeout(15000);
let locale = (await page
  .getByRole("button", { name: dictionaries.zh.nav.settings, exact: true })
  .filter({ visible: true })
  .count())
  ? "zh"
  : "en";
const t = (key) => {
  const value = key.split(".").reduce((value, part) => value?.[part], dictionaries[locale]);
  const text = typeof value === "object" ? value?.$self : value;
  if (typeof text !== "string") throw new Error("Missing label: " + key);
  return text;
};
const button = (name) => page.getByRole("button", { name, exact: true }).filter({ visible: true });
const shots = [];
const verified = [];
async function capture(state) {
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains("dark")),
    target.theme === "dark"
  );
  await page.mouse.move(1400, 42);
  await page.waitForTimeout(250);
  const file = "media/desktop/" + locale + "/details-remote-" + state + ".png";
  await page.screenshot({ path: path.join(target.publicRoot, file) });
  shots.push({ file, locale, state, theme: target.theme, native: true });
  console.log(locale + "/remote-" + state);
}
try {
  await target.verify(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.keyboard.press("Escape");
  await button(t("nav.home")).click();
  assert.equal(await button(t("common.stop")).count(), 0);
  await page
    .getByRole("button", { name: /^Schale Demo / })
    .filter({ visible: true })
    .click();
  if ((await button(t("remote.emulator")).getAttribute("aria-pressed")) === "true")
    await button(t("remote.emulator")).click();
  for (const nextLocale of ["en", "zh"]) {
    await button(t("nav.settings")).click();
    await page
      .getByRole("navigation", { name: t("settings.categories"), exact: true })
      .getByRole("button", { name: t("settings.sections.general"), exact: true })
      .click();
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
    await page.getByRole("navigation", { name: t("settings.categories"), exact: true })
      .getByRole("button", { name: t("settings.sections.appearance"), exact: true }).click();
    await page.getByRole("group", { name: t("common.theme"), exact: true })
      .getByRole("button", { name: t(`common.theme.${target.theme}`), exact: true }).click();
    await button(t("nav.home")).click();
    await button(t("remote.emulator")).click();
    await page.waitForFunction(() => {
      const video = document.querySelector(".home-log-body video");
      return video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
    });
    const frame = await page.locator(".home-log-body video").evaluate((video) => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const context = canvas.getContext("2d");
      context.drawImage(video, 0, 0, 64, 64);
      const pixels = context.getImageData(0, 0, 64, 64).data;
      const colors = new Set();
      let bright = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        colors.add((pixels[i] >> 4) + "," + (pixels[i + 1] >> 4) + "," + (pixels[i + 2] >> 4));
        if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 90) bright++;
      }
      return {
        width: video.videoWidth,
        height: video.videoHeight,
        sampledColors: colors.size,
        nonDarkPixels: bright,
      };
    });
    assert.ok(
      frame.sampledColors > 8 && frame.nonDarkPixels > 100,
      "Remote video must be nonblank"
    );
    verified.push({
      locale,
      check: "actual emulator preview decoded nonblank video; no game input sent",
      ...frame,
    });
    await capture("preview");
    const remote = page.locator(".home-log-body > div.right-5.top-3");
    await remote.locator(":scope > div").first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.equal(await dialog.locator("video").count(), 1);
    await capture("enlarged");
    await dialog.getByRole("button", { name: t("remote.advanced"), exact: true }).click();
    await page.waitForTimeout(400);
    await dialog
      .getByRole("button", { name: t("remote.saveAndApply"), exact: true })
      .scrollIntoViewIfNeeded();
    const saveBounds = await dialog.getByRole("button", { name: t("remote.saveAndApply"), exact: true }).boundingBox();
    assert.ok(saveBounds && saveBounds.y + saveBounds.height <= await page.evaluate(() => innerHeight));
    await capture("advanced");
    await dialog.getByRole("button", { name: t("common.close"), exact: true }).click();
    await button(t("remote.emulator")).click();
  }
  writeFileSync(
    path.join(target.publicRoot, "media/desktop/remote-manifest.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        sourceRevision: base.sourceRevision,
        scope:
          "Desktop native release mirroring actual MuMu Android BAAS UI over its real backend. This is not a game-task completion test. No remote input, clipboard, power commands or video-setting changes were submitted.",
        verified,
        shots,
      },
      null,
      2
    ) + "\n"
  );
} finally {
  await browser.close();
}
