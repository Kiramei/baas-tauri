import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExportServer } from "./static-export-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const server = createExportServer(path.join(root, "docs/out"), "");
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const cache = path.join(root, ".cache/baasx-docs");
mkdirSync(cache, { recursive: true });
const cases = [],
  errors = [];
const routes = {
  quickstart: "",
  configuration: "configuration/",
  scheduler: "scheduler/",
  packs: "command-packs/",
};

try {
  for (const locale of ["zh", "en"])
    for (const theme of ["light", "dark"])
      for (const mobile of [false, true]) {
        if (process.argv.includes("--smoke") && (locale !== "zh" || theme !== "dark" || mobile))
          continue;
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 },
          reducedMotion: "reduce",
        });
        await context.addInitScript((theme) => localStorage.setItem("theme", theme), theme);
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        const text = (zh, en) => (locale === "zh" ? zh : en);
        await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
        assert.equal((await page.goto(`${base}/docs/${locale}/baasx/installation/`)).status(), 200);
        const tabs = page.getByRole("tablist", {
          name: text("包管理器", "Package manager"),
          exact: true,
        });
        const install = tabs.locator("../..");
        const copy = install.getByRole("button", { name: text("复制命令", "Copy command"), exact: true });
        for (const [name, command] of [
          ["npm", "npm install -g @kiramei/baasx"],
          ["pnpm", "pnpm add -g @kiramei/baasx"],
          ["yarn", "yarn global add @kiramei/baasx"],
          ["bun", "bun add -g baasx"],
          ["cnpm", "cnpm install -g @kiramei/baasx"],
          ["deno", "deno install -g -A npm:@kiramei/baasx"],
        ]) {
          const tab = tabs.getByRole("tab", { name, exact: true });
          await tab.click();
          assert.equal(await tab.getAttribute("aria-selected"), "true");
          const code = install.locator("pre code:visible");
          assert.equal(await code.innerText(), command);
          const inlineStyle = await code.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              borderWidth: style.borderWidth,
              borderRadius: style.borderRadius,
              background: style.backgroundColor,
            };
          });
          assert.deepEqual(inlineStyle, {
            borderWidth: "0px",
            borderRadius: "0px",
            background: "rgba(0, 0, 0, 0)",
          });
          await copy.click();
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), command);
          assert.equal(await install.getByRole("status").textContent(), text("已复制", "Copied"));
        }
        cases.push({ locale, theme, mobile, scenario: "package-manager-install", passed: true });
        for (const [scenario, route] of Object.entries(routes)) {
          assert.equal((await page.goto(`${base}/docs/${locale}/baasx/${route}`)).status(), 200);
          const demo = page.locator(`[data-baasx-demo="${scenario}"]`);
          await demo.scrollIntoViewIfNeeded();
          await demo.locator(".xterm-screen").waitFor();
          const terminalInput = demo.getByRole("textbox", {
            name: text("BAASX 离线演示终端输入", "BAASX offline demo terminal input"),
            exact: true,
          });
          const send = async (value) => {
            await terminalInput.focus();
            await page.keyboard.insertText(value);
            await page.keyboard.press("Enter");
          };
          const key = async (value) => {
            await terminalInput.focus();
            await page.keyboard.press(value);
          };
          const clickCellText = async (value, lineMatch = () => true) => {
            const lines = (await demo.getByTestId("baasx-screen-text").textContent()).split("\n");
            const row = lines.findIndex((line) => line.includes(value) && lineMatch(line));
            assert.ok(row >= 0, `Visible terminal text not found: ${value}`);
            const prefix = lines[row].slice(0, lines[row].indexOf(value));
            const cellWidth = (text) =>
              [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].reduce(
                (sum, { segment }) =>
                  sum +
                  (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(
                    segment
                  )
                    ? 2
                    : 1),
                0
              );
            const screen = await demo.locator(".xterm-screen").boundingBox();
            const columns = Number(await demo.getAttribute("data-cols"));
            const rows = Number(await demo.getAttribute("data-rows"));
            await page.mouse.click(
              screen.x + ((cellWidth(prefix) + 1) * screen.width) / columns,
              screen.y + ((row + 0.5) * screen.height) / rows
            );
          };
          const checkPage = async (expected) => {
            await page.waitForFunction(
              ({ scenario, expected }) =>
                document
                  .querySelector(`[data-baasx-demo="${scenario}"]`)
                  ?.getAttribute("data-page") === expected,
              { scenario, expected }
            );
          };
          const next = demo.getByRole("button", {
            name: text("演示下一步", "Show next step"),
            exact: true,
          });
          let steps = 0;
          while (await next.isEnabled()) {
            assert.ok(++steps <= 20, "Walkthrough must finish");
            await next.click();
          }
          assert.ok(steps >= 5);
          await checkPage(
            scenario === "configuration" ? "config" : scenario === "scheduler" ? "logs" : "home"
          );
          assert.equal(await demo.getAttribute("data-running"), "false");

          // Every operation is entered through xterm, without a separate command form.
          assert.equal(await demo.locator("form").count(), 0);
          await send("/home");
          await checkPage("home");
          const transcript = demo.getByTestId("baasx-transcript");
          if (scenario === "configuration") {
            assert.match(await transcript.textContent(), /1 \/ 1 \/ 1 \/ 1/);
            assert.match(
              await transcript.textContent(),
              locale === "zh" ? /金属 › 花/ : /Metal › Flower/
            );
          }
          await send("/start");
          assert.equal(await demo.getAttribute("data-running"), "true");
          assert.doesNotMatch(
            await transcript.textContent(),
            /确认此演示操作|Confirm this sample action/
          );
          await send("/reload");
          await checkPage("home");
          assert.equal(
            await demo.getAttribute("data-running"),
            "true",
            "Reload keeps the active run"
          );
          await send("/stop");
          assert.match(await transcript.textContent(), /确认此演示操作|Confirm this sample action/);
          await key("ArrowRight");
          await key("Enter");
          assert.equal(
            await demo.getAttribute("data-running"),
            "true",
            "Cancel does not stop a run"
          );
          await send("/stop");
          await key("Enter");
          assert.equal(await demo.getAttribute("data-running"), "false");
          await send("/run mail");
          assert.match(await transcript.textContent(), /确认此演示操作|Confirm this sample action/);
          await key("Escape");
          assert.equal(await demo.getAttribute("data-running"), "false");
          await send("/pack briefing");
          assert.doesNotMatch(
            await transcript.textContent(),
            /确认此演示操作|Confirm this sample action/
          );
          assert.match(await transcript.textContent(), /status.*tasks/);
          await send("/not-a-command");
          assert.match(
            await transcript.textContent(),
            locale === "zh" ? /只模拟列出的命令/ : /simulates only its listed commands/
          );

          // Reset and explicit playback are independent of app commands.
          await demo.getByRole("button", { name: text("重置", "Reset"), exact: true }).click();
          await demo
            .getByRole("button", { name: text("自动演示", "Play walkthrough"), exact: true })
            .click();
          assert.equal(await demo.getAttribute("data-playing"), "true");
          await demo
            .getByRole("button", { name: text("暂停演示", "Pause demo"), exact: true })
            .click();
          assert.equal(await demo.getAttribute("data-playing"), "false");
          await demo
            .getByRole("button", { name: text("继续演示", "Resume demo"), exact: true })
            .click();
          assert.equal(await demo.getAttribute("data-playing"), "true");
          await demo.getByRole("button", { name: text("重置", "Reset"), exact: true }).click();

          // Command completion and keyboard navigation also happen inside xterm.
          await terminalInput.focus();
          await page.keyboard.insertText("/hel");
          await page.keyboard.press("Tab");
          await page.keyboard.press("Enter");
          await checkPage("help");
          await send("/profiles");
          await checkPage("profiles");
          await key("Enter");
          await checkPage("home");
          await send("/config");
          await key("Enter");
          await checkPage("counts");
          await key("ArrowDown");
          await key("+");
          await key("Control+s");
          await key("Enter");
          await key("Control+r");
          await checkPage("home");
          assert.match(await transcript.textContent(), /1 \/ 1 \/ 1 \/ 1/);
          await terminalInput.focus();
          await page.keyboard.press("Tab");
          assert.ok(
            await page.evaluate(
              () => !document.activeElement?.classList.contains("xterm-helper-textarea")
            ),
            "Tab must leave the embedded terminal"
          );
          if (scenario === "quickstart") {
            await send("/home");
            await clickCellText(text("任务", "Tasks"), (line) =>
              line.includes(text("总览", "Overview"))
            );
            await checkPage("tasks");
            await clickCellText("mail");
            assert.match(await transcript.textContent(), /run mail/);
            await key("ArrowRight");
            // Clicking Yes must ignore a previously selected cancellation choice.
            await clickCellText(text("确认", "Confirm"), (line) =>
              line.includes(text("取消", "Cancel"))
            );
            assert.equal(await demo.getAttribute("data-running"), "true");
            await send("/stop");
            await clickCellText(text("取消", "Cancel"), (line) =>
              line.includes(text("确认", "Confirm"))
            );
            assert.equal(await demo.getAttribute("data-running"), "true");
            await send("/stop");
            await key("Enter");
            if (!mobile) {
              await demo
                .getByRole("button", { name: text("展开终端", "Expand terminal"), exact: true })
                .click();
              await send("/start");
              await send("/home");
              await page.waitForFunction(
                (scenario) =>
                  Number(
                    document
                      .querySelector(`[data-baasx-demo="${scenario}"]`)
                      ?.getAttribute("data-divider-column")
                  ) > 0,
                scenario
              );
              const before = Number(await demo.getAttribute("data-split"));
              let x, y, dividerReady = false;
              for (let attempt = 0; attempt < 40 && !dividerReady; attempt++) {
                const screen = await demo.locator(".xterm-screen").boundingBox();
                const columns = Number(await demo.getAttribute("data-cols"));
                const rows = Number(await demo.getAttribute("data-rows"));
                const divider = Number(await demo.getAttribute("data-divider-column"));
                x = screen.x + ((divider + 0.5) * screen.width) / columns;
                y = screen.y + (10.5 * screen.height) / rows;
                await page.mouse.move(x, y);
                dividerReady = await demo.evaluate((node, point) => {
                  const screen = node.querySelector(".xterm-screen")?.getBoundingClientRect();
                  const columns = Number(node.getAttribute("data-cols"));
                  const rows = Number(node.getAttribute("data-rows"));
                  const divider = Number(node.getAttribute("data-divider-column"));
                  if (!screen || divider < 0) return false;
                  const currentX = screen.x + ((divider + 0.5) * screen.width) / columns;
                  const currentY = screen.y + (10.5 * screen.height) / rows;
                  return Math.abs(point.x - currentX) < 1 && Math.abs(point.y - currentY) < 1 &&
                    node.querySelector('[data-testid="baasx-terminal"]')?.style.cursor === "col-resize";
                }, { x, y });
                if (!dividerReady) await page.waitForTimeout(50);
              }
              assert.ok(dividerReady, "The terminal divider is ready for dragging");
              await page.mouse.down();
              await page.mouse.move(x + 65, y, { steps: 8 });
              await page.mouse.up();
              await page.waitForFunction(
                ({ scenario, before }) =>
                  Number(document.querySelector(`[data-baasx-demo="${scenario}"]`)?.getAttribute("data-split")) >
                  before + 0.02,
                { scenario, before }
              );
              await send("/stop");
              await key("Enter");
              await demo
                .getByRole("button", { name: text("退出大屏", "Exit expanded view"), exact: true })
                .click();
            }
          }
          await demo.getByRole("button", { name: text("重置", "Reset"), exact: true }).click();
          await demo.scrollIntoViewIfNeeded();
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            "No horizontal page overflow"
          );
          const bounds = await demo.boundingBox();
          assert.ok(
            bounds &&
              bounds.x >= 0 &&
              bounds.width > 250 &&
              bounds.x + bounds.width <= (mobile ? 391 : 1441)
          );
          if (theme === "dark")
            await demo.screenshot({
              path: path.join(cache, `${locale}-${scenario}-${mobile ? "mobile" : "desktop"}.png`),
            });
          cases.push({ locale, theme, mobile, scenario, guidedSteps: steps, passed: true });
        }
        await context.close();
      }

  // Real timers complement the reduced-motion matrix; keep this in one context.
  const timingContext = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: "no-preference",
  });
  try {
    await timingContext.addInitScript(() => localStorage.setItem("theme", "dark"));
    const page = await timingContext.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    assert.equal((await page.goto(`${base}/docs/zh/baasx/`)).status(), 200);
    const demo = page.locator('[data-baasx-demo="quickstart"]');
    await demo.scrollIntoViewIfNeeded();
    await demo.locator(".xterm-screen").waitFor();
    assert.equal(
      await demo
        .locator(".xterm-viewport")
        .evaluate((node) => getComputedStyle(node).backgroundColor),
      "rgb(32, 36, 44)",
      "Unused pixels below the last terminal row share the terminal background"
    );
    const screen = demo.getByTestId("baasx-screen-text");
    const transcript = demo.getByTestId("baasx-transcript");
    const guide = demo.getByText(/^\d+\/7$/);
    await demo.getByRole("button", { name: "自动演示", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-baasx-demo="quickstart"]')?.getAttribute("data-running") ===
        "true"
    );
    assert.equal(await demo.getAttribute("data-playing"), "true");
    assert.equal(await guide.textContent(), "2/7", "Playback reaches the running step itself");

    await demo.getByRole("button", { name: "暂停演示", exact: true }).click();
    assert.equal(await demo.getAttribute("data-playing"), "false");
    const pausedScreen = await screen.textContent();
    const pausedTranscript = await transcript.textContent();
    const pausedGuide = await guide.textContent();
    // Longer than both the 1500 ms run tick and the 1900 ms walkthrough delay.
    await page.waitForTimeout(2300);
    assert.equal(await screen.textContent(), pausedScreen, "Pause freezes the running animation");
    assert.equal(await transcript.textContent(), pausedTranscript, "Pause freezes run progress");
    assert.equal(await guide.textContent(), pausedGuide, "Pause freezes the walkthrough step");
    assert.equal(await demo.getAttribute("data-running"), "true");

    await demo.getByRole("button", { name: "继续演示", exact: true }).click();
    await demo.getByText("3/7", { exact: true }).waitFor();
    assert.equal(await demo.getAttribute("data-playing"), "true");
    assert.notEqual(await transcript.textContent(), pausedTranscript, "Resume advances the run");

    await demo.getByRole("button", { name: "重置", exact: true }).click();
    const terminalInput = demo.getByRole("textbox", {
      name: "BAASX 离线演示终端输入",
      exact: true,
    });
    await terminalInput.focus();
    await page.keyboard.insertText("/start");
    await page.keyboard.press("Enter");
    assert.equal(await demo.getAttribute("data-running"), "true");
    assert.equal(await demo.getAttribute("data-playing"), "false");
    const firstStar = (await screen.textContent())
      .split("\n")
      .find((line) => /^ [·✢*✶✻✽] /.test(line))?.[1];
    assert.ok(firstStar, "A running task shows its star even while a notice is displayed");
    await page.waitForFunction(
      (before) => {
        const text = document.querySelector(
          '[data-baasx-demo="quickstart"] [data-testid="baasx-screen-text"]'
        )?.textContent;
        const star = text?.split("\n").find((line) => /^ [·✢*✶✻✽] /.test(line))?.[1];
        return star && star !== before;
      },
      firstStar,
      { timeout: 1200 }
    );
    await demo.getByRole("button", { name: "重置", exact: true }).click();
    cases.push({
      locale: "zh",
      theme: "dark",
      mobile: false,
      scenario: "quickstart-timing",
      playback: "advanced, paused beyond both timers, resumed",
      animation: "star changed after manual /start",
      passed: true,
    });
  } finally {
    await timingContext.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(
    path.join(cache, "validation.json"),
    JSON.stringify({ cases, errors }, null, 2) + "\n"
  );
  console.log(JSON.stringify({ cases: cases.length, errors }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
