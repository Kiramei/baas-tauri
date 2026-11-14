// Run against `bun run dev:webui --host 127.0.0.1 --port 8317` with Playwright installed.
// PLAYWRIGHT_MODULE may point to an external installation; no backend/device is contacted.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixtureRoot = await mkdtemp(join(tmpdir(), "baas-profile-import-"));
const configRoot = join(fixtureRoot, "config");
for (const folder of ["alpha", "beta", "broken"]) {
  await mkdir(join(configRoot, folder), { recursive: true });
  await writeFile(
    join(configRoot, folder, "config.json"),
    folder === "broken" ? "{invalid" : JSON.stringify({ name: `批量导入-${folder}`, server: "CN" })
  );
  await writeFile(join(configRoot, folder, "event.json"), "[]");
}
await writeFile(join(configRoot, "gui.json"), "{}");
await mkdir(join(fixtureRoot, "empty"));
await writeFile(join(fixtureRoot, "empty", "gui.json"), "{}");
await writeFile(
  join(fixtureRoot, "single.zip"),
  zipSync({
    "config.json": strToU8(JSON.stringify({ name: "单配置导入测试", server: "CN" })),
    "event.json": strToU8("[]"),
  })
);
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const url = `${process.env.FIXTURE_ORIGIN || "http://127.0.0.1:8317"}/tests/browser/workspace.html?profileFeatures=1&page=plugins&theme=dark`;
const metrics = () =>
  page.evaluate(() =>
    Object.fromEntries(
      ['[data-page="plugins"]', "[data-plugin-list-scroll]", "[data-plugin-detail-scroll]"].map(
        (s) => {
          const e = document.querySelector(s);
          return [
            s,
            {
              top: e.scrollTop,
              height: e.clientHeight,
              total: e.scrollHeight,
              overflow: getComputedStyle(e).overflowY,
            },
          ];
        }
      )
    )
  );
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator("[data-plugin-detail] input").first().waitFor({ timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const search = page.getByRole("textbox", { name: "搜索插件" });
  const searchY = (await search.boundingBox()).y;
  const list = page.locator("[data-plugin-list-scroll]");
  await list.hover();
  await page.mouse.wheel(0, 420);
  await page.waitForTimeout(200);
  let m = await metrics();
  assert(m["[data-plugin-list-scroll]"].top > 0);
  assert.equal(m["[data-plugin-detail-scroll]"].top, 0);
  assert.equal(m['[data-page="plugins"]'].top, 0);
  assert.equal((await search.boundingBox()).y, searchY);
  const leftTop = m["[data-plugin-list-scroll]"].top;
  await page.locator("[data-plugin-detail-scroll]").hover();
  await page.mouse.wheel(0, 420);
  await page.waitForTimeout(200);
  m = await metrics();
  assert(m["[data-plugin-detail-scroll]"].top > 0);
  assert.equal(m["[data-plugin-list-scroll]"].top, leftTop);
  assert.equal(m['[data-page="plugins"]'].top, 0);
  console.log("PASS 1600px independent wheel scroll, fixed search, no outer scroll");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(200);
  m = await metrics();
  assert.equal(m['[data-page="plugins"]'].overflow, "hidden");
  assert(m["[data-plugin-list-scroll]"].total > m["[data-plugin-list-scroll]"].height);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(200);
  m = await metrics();
  assert.equal(m['[data-page="plugins"]'].overflow, "auto");
  assert.equal(m["[data-plugin-list-scroll]"].overflow, "visible");
  await page.locator("[data-plugin-detail] input").last().scrollIntoViewIfNeeded();
  assert(await page.locator("[data-plugin-detail] input").last().isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log("PASS 1280px two columns; 1024px single scroll with last settings reachable");
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "新增配置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.locator("[data-profile-name]").fill("未保存的名字");
  await dialog.getByRole("button", { name: "导入配置", exact: true }).click();
  await dialog.getByRole("button", { name: "导入配置压缩包", exact: true }).waitFor();
  await page.waitForTimeout(260);
  if (process.env.ARTIFACT_DIR)
    await page.screenshot({ path: join(process.env.ARTIFACT_DIR, "profile-import-pane.png") });
  await page.keyboard.press("Escape");
  await dialog.locator("[data-profile-name]").waitFor();
  assert.equal(await dialog.locator("[data-profile-name]").inputValue(), "未保存的名字");
  await dialog.getByRole("button", { name: "导入配置", exact: true }).click();
  let [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: "从文件夹批量导入配置", exact: true }).click(),
  ]);
  // Playwright cannot cancel a native directory chooser; dispatch its browser cancel event.
  await chooser.element().dispatchEvent("cancel");
  await page.waitForTimeout(300);
  assert(await dialog.isVisible());
  assert.equal(await dialog.getAttribute("aria-busy"), "false");
  [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: "从文件夹批量导入配置", exact: true }).click(),
  ]);
  await chooser.setFiles(configRoot);
  await dialog
    .getByText("已导入 2 个配置，1 个失败。", { exact: true })
    .waitFor({ timeout: 30000 });
  assert(await dialog.getByText(/broken:/).isVisible());
  assert(await page.getByText("批量导入-alpha", { exact: true }).first().isVisible());
  console.log(
    "PASS import pane transition/back preserves form, picker cancel, batch 2 valid + 1 invalid profile"
  );
  [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: "从文件夹批量导入配置", exact: true }).click(),
  ]);
  await chooser.setFiles(join(fixtureRoot, "empty"));
  await dialog
    .getByRole("alert")
    .getByText("所选文件夹中未找到包含 config.json 的子配置文件夹。", { exact: true })
    .waitFor();
  [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: "导入配置压缩包", exact: true }).click(),
  ]);
  await chooser.setFiles(join(fixtureRoot, "single.zip"));
  await dialog.waitFor({ state: "hidden" });
  assert(await page.getByText("单配置导入测试", { exact: true }).first().isVisible());
  console.log(
    "PASS empty folder error; existing single ZIP import closes dialog and updates profile"
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "新增配置", exact: true }).click();
  await dialog.getByRole("button", { name: "导入配置", exact: true }).click();
  await dialog.getByRole("button", { name: "从文件夹批量导入配置", exact: true }).waitFor();
  await page.waitForTimeout(260);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.ARTIFACT_DIR)
    await page.screenshot({ path: join(process.env.ARTIFACT_DIR, "profile-import-mobile.png") });
  console.log("PASS 390px import pane and reduced motion");
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(url + "&importSessionChange=1", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "新增配置", exact: true }).click();
  await dialog.getByRole("button", { name: "导入配置", exact: true }).click();
  [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: "从文件夹批量导入配置", exact: true }).click(),
  ]);
  await chooser.setFiles(configRoot);
  await dialog.getByText("已导入 1 个配置，2 个失败。", { exact: true }).waitFor();
  assert(await dialog.getByText(/beta: 连接会话已更换/).isVisible());
  assert.equal(await page.getByText("批量导入-beta", { exact: true }).count(), 0);
  console.log("PASS session change prevents sending remaining archives to a new connection");
  await page.goto(url + "&catalogErrors=1", { waitUntil: "domcontentloaded" });
  await page.locator("[data-plugin-detail] input").first().waitFor();
  const notice = await page.locator("[data-plugin-catalog-errors]").evaluate((element) => ({
    height: element.clientHeight,
    total: element.scrollHeight,
    overflow: getComputedStyle(element).overflowY,
  }));
  assert(notice.height <= 112 && notice.total > notice.height);
  assert.equal(notice.overflow, "auto");
  assert((await metrics())["[data-plugin-detail-scroll]"].height > 200);
  console.log("PASS long catalog errors stay scrollable without collapsing plugin columns");
  assert.deepEqual(errors, []);
  console.log("PASS no browser runtime errors");
} finally {
  await browser.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}
