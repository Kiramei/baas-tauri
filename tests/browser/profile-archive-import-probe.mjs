// Run against the isolated browser fixture. No backend, native window or device is contacted.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = await mkdtemp(join(tmpdir(), "baas-legacy-import-"));
const selected = join(root, "default_config");
const config = JSON.stringify({ name: "新的配置", server: "官服" });
await mkdir(selected);
await writeFile(join(selected, "config.json"), config);
await writeFile(join(selected, "event.json"), "[]");
const bytes = zipSync({
  "default_config/config.json": strToU8(config),
  "default_config/event.json": strToU8("[]"),
});
const filename = join(root, "default_config.zip");
await writeFile(filename, bytes);
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${process.env.FIXTURE_ORIGIN || "http://127.0.0.1:8317"}/tests/browser/workspace.html?profileFeatures=1`
  );
  const dialog = page.getByRole("dialog");
  const openImport = async () => {
    await page.getByRole("button", { name: "新增配置", exact: true }).click();
    await dialog.getByRole("button", { name: "导入配置", exact: true }).click();
  };
  await openImport();
  let [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: "导入配置压缩包", exact: true }).click(),
  ]);
  await chooser.setFiles(filename);
  await dialog.waitFor({ state: "hidden" });
  const inspect = () =>
    page.evaluate(
      () =>
        new Promise((reply) =>
          window.dispatchEvent(new CustomEvent("fixture:import-results", { detail: reply }))
        )
    );
  let result = await inspect();
  assert.equal(result.imports[0].name, "New Profile");
  assert.equal(result.profiles[result.imports[0].serial], "New Profile");

  // The browser drag/drop route must use the same normalization and allocator.
  await page.evaluate(
    (data) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(data)], "arbitrary-old-name.zip", { type: "application/zip" })
      );
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true }));
    },
    [...bytes]
  );
  await page.waitForFunction(() => {
    let count = 0;
    window.dispatchEvent(
      new CustomEvent("fixture:import-results", {
        detail: (value) => {
          count = value.imports.length;
        },
      })
    );
    return count === 2;
  });
  result = await inspect();
  assert.equal(result.imports[1].name, "New Profile (2)");
  assert.equal(result.profiles[result.imports[0].serial], "New Profile");
  assert.equal(result.profiles[result.imports[1].serial], "New Profile (2)");

  // A selected profile directory itself is accepted, including default_config.
  await openImport();
  [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: "从文件夹批量导入配置", exact: true }).click(),
  ]);
  await chooser.setFiles(selected);
  await dialog.getByText("已导入 1 个配置，0 个失败。", { exact: true }).waitFor();
  result = await inspect();
  assert.deepEqual(
    result.imports.map((item) => item.name),
    ["New Profile", "New Profile (2)", "New Profile (3)"]
  );
  assert.equal(new Set(result.imports.map((item) => item.root)).size, 3);
  for (const item of result.imports) {
    assert.match(item.root, /^profile-[a-f0-9-]+$/);
    assert.equal(item.filename, item.root + ".zip");
    assert(item.files.includes(item.root + "/config.json"));
    assert(item.files.includes(item.root + "/event.json"));
    assert.equal(result.profiles[item.serial], item.name);
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS single ZIP, browser drop, selected default_config directory, collision-safe names, fresh roots and ACK IDs"
  );
} finally {
  await browser.close();
  await rm(root, { recursive: true, force: true });
}
