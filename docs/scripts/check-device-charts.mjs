import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, ".cache/docs-device-charts");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const cases = [];
try {
  for (const locale of ["en", "zh"])
    for (const theme of ["light", "dark"]) {
      for (const width of [1440, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 960 },
        });
        await context.addInitScript((theme) => localStorage.setItem("theme", theme), theme);
        const page = await context.newPage();
        await page.goto(
          (process.argv[2] || "http://127.0.0.1:4173") + `/docs/${locale}/reference/performance/`
        );
        await page.waitForFunction(
          (dark) => document.documentElement.classList.contains("dark") === dark,
          theme === "dark"
        );
        for (const kind of ["capture", "control"]) {
          const chart = page.locator(".baas-device-" + kind);
          await chart
            .locator("select")
            .selectOption(kind === "capture" ? "animated" : "long_click");
          await chart.getByRole("button", { name: "p95", exact: true }).click();
          if (kind === "control")
            await chart
              .getByRole("button", {
                name: locale === "zh" ? "画面确认" : "Visible response",
                exact: true,
              })
              .click();
          await chart.scrollIntoViewIfNeeded();
          const rows = await chart.locator(".baas-benchmark-row").evaluateAll((elements) =>
            elements.map((row) => {
              const label = row.children[0].getBoundingClientRect();
              const track = row.children[1].getBoundingClientRect();
              const value = row.children[2].getBoundingClientRect();
              return {
                labelRight: label.right,
                trackLeft: track.left,
                trackRight: track.right,
                valueLeft: value.left,
                valueFits: row.children[2].scrollWidth <= row.children[2].clientWidth,
              };
            })
          );
          assert.equal(rows.length, 4);
          for (const row of rows) {
            assert.ok(
              row.labelRight < row.trackLeft && row.trackRight < row.valueLeft && row.valueFits
            );
          }
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
            )
          );
          const file = `${locale}-${theme}-${width}-${kind}.png`;
          const png = await chart.screenshot({ path: path.join(output, file) });
          assert.ok(png.length > 2000);
          cases.push({
            locale,
            theme,
            width,
            kind,
            file,
            rows: 4,
            output: await chart.locator("output").allTextContents(),
            passed: true,
          });
        }
        await context.close();
      }
    }
} finally {
  await browser.close();
}
writeFileSync(
  path.join(root, "docs/evidence/device-chart-validation.json"),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      rawRecordSha256: createHash("sha256")
        .update(readFileSync(path.join(root, "docs/public/benchmarks/device-current.json")))
        .digest("hex"),
      scope:
        "Animated capture and long-press visible-response p95 layout/screenshots; the complete metric/scenario matrix is covered by smoke-docs.mjs",
      cases,
    },
    null,
    2
  ) + "\n"
);
console.log(JSON.stringify({ passed: cases.length }));
