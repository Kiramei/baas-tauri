import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.argv[2] || "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });
const assets = ["BAAS_1.0_aarch64.dmg", "BAAS_1.0_x64.dmg"].map((name) => ({
  name,
  size: 1048576,
  browser_download_url: `https://example.com/${name}`,
}));

try {
  for (const architecture of ["arm", "x86", "unknown"]) {
    const context = await browser.newContext({ locale: "zh-CN" });
    await context.addInitScript((arch) => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        configurable: true,
      });
      Object.defineProperty(navigator, "userAgentData", {
        configurable: true,
        value: arch === "unknown" ? undefined : {
          platform: "macOS",
          getHighEntropyValues: async () => ({ architecture: arch, bitness: "64" }),
        },
      });
    }, architecture);
    const page = await context.newPage();
    await page.route("https://api.github.com/repos/Kiramei/baas-tauri/releases/latest", (route) =>
      route.fulfill({ json: { tag_name: "v1.0", html_url: "https://example.com/releases", assets } })
    );
    await page.goto(`${base}/docs/guide/install/`);
    const panel = page.locator(".baas-download-panel");
    const card = panel.locator(".baas-download-platform-card strong");
    const expected = architecture === "arm" ? "macOS Apple Silicon DMG" :
      architecture === "x86" ? "macOS Intel DMG" : "选择芯片";
    await card.getByText(expected, { exact: true }).waitFor();
    if (architecture === "unknown") {
      assert.equal(await panel.locator("a.baas-download-primary").count(), 0);
      await panel.locator(".baas-download-package-select button").first().click();
      await panel.getByRole("option", { name: /Apple Silicon/ }).click();
      assert.match(await panel.locator("a.baas-download-primary").getAttribute("href"), /aarch64\.dmg$/);
    } else {
      const expectedFile = architecture === "arm" ? /aarch64\.dmg$/ : /x64\.dmg$/;
      await page.waitForFunction((file) =>
        document.querySelector(".baas-download-primary")?.getAttribute("href")?.endsWith(file),
        architecture === "arm" ? "aarch64.dmg" : "x64.dmg"
      );
      assert.match(await panel.locator("a.baas-download-primary").getAttribute("href"), expectedFile);
    }
    assert.doesNotMatch(await panel.innerText(), /已根据你的系统|recommended package is selected/i);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log("Download architecture: Apple Silicon, Intel and manual selection passed");
