// Run with the existing Vite server; no backend or device commands are sent.
// PLAYWRIGHT_MODULE may point to an external Playwright installation.
// READONLY_LOG_PERF=1 also measures the completed terminal's 10k-line buffer.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.FIXTURE_ORIGIN || "http://127.0.0.1:8317";
const artifacts = process.env.ARTIFACT_DIR || join(tmpdir(), "baas-android-readonly-terminal");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 820, height: 560 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/__readonly-terminal-probe__", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><head><title>Android read-only terminal probe</title></head><body></body></html>",
    })
  );
  await page.goto(`${origin}/__readonly-terminal-probe__`);
  await page.addStyleTag({ url: `${origin}/node_modules/@xterm/xterm/css/xterm.css` });
  await page.addScriptTag({ url: `${origin}/node_modules/@xterm/xterm/lib/xterm.js` });
  const result = await page.evaluate(
    async ({ origin, measurePerformance }) => {
      const { Terminal } = window;
      const { attachAndroidReadOnlyTerminal } = await import(
        `${origin}/src/shared/AndroidReadOnlyTerminal.ts`
      );
      const settle = () =>
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const create = (cols = 20, scrollback = 64) => {
        const host = document.createElement("div");
        Object.assign(host.style, { width: "680px", height: "100px", marginBottom: "20px" });
        document.body.append(host);
        const term = new Terminal({
          cols,
          rows: 4,
          scrollback,
          convertEol: true,
          fontSize: 14,
          lineHeight: 1.2,
          theme: { foreground: "#dbe7f3", background: "#0b1220" },
        });
        term.open(host);
        const detach = attachAndroidReadOnlyTerminal(term, host);
        return {
          host,
          term,
          pre: host.querySelector("pre"),
          write: async (value) => {
            await new Promise((resolve) => term.write(value, resolve));
            await settle();
          },
          detach,
          close: () => {
            detach();
            term.dispose();
            host.remove();
          },
        };
      };
      const result = {};
      const wrapped = create(8);
      const originalText = "https://example.test/中文😀/long-path";
      await wrapped.write(originalText);
      result.wrap = {
        overlay: wrapped.pre.textContent,
        expected: originalText + "\n",
        hasWrappedBufferLine: Array.from(
          { length: wrapped.term.buffer.active.length },
          (_, index) => wrapped.term.buffer.active.getLine(index)?.isWrapped
        ).some(Boolean),
      };
      result.noneditable = {
        readonly: wrapped.term.textarea.readOnly,
        inputMode: wrapped.term.textarea.inputMode,
        tabIndex: wrapped.term.textarea.tabIndex,
        layerEditable: wrapped.pre.isContentEditable,
      };
      wrapped.close();

      const colors = create();
      await colors.write("\u001b[7mINVERSE\u001b[0m\r\n\u001b[38;2;17;34;51mRGB\u001b[0m");
      const coloredRuns = colors.pre.querySelectorAll("span span");
      result.colors = {
        inverseForeground: getComputedStyle(coloredRuns[0]).color,
        inverseBackground: getComputedStyle(coloredRuns[0]).backgroundColor,
        rgb: getComputedStyle(coloredRuns[1]).color,
      };
      colors.close();

      const recolor = create();
      await recolor.write("A\r\nB");
      const before = getComputedStyle(recolor.pre.querySelector("span span")).color;
      await recolor.write("\u001b[1A\r\u001b[31mA\u001b[0m\u001b[1B\r");
      result.recolor = {
        before,
        after: getComputedStyle(recolor.pre.querySelector("span span")).color,
        text: recolor.pre.textContent,
      };
      recolor.close();

      const reset = create();
      await reset.write("old\r\nlog");
      reset.term.reset();
      reset.term.clear();
      await settle();
      result.reset = reset.pre.textContent;
      reset.close();

      const selection = create();
      await selection.write("中文😀A");
      const range = document.createRange();
      range.selectNodeContents(selection.pre.firstChild);
      document.getSelection().removeAllRanges();
      document.getSelection().addRange(range);
      await settle();
      const selectedNode = selection.pre.firstChild;
      const selectedText = document.getSelection().toString();
      await selection.write("\r\nnext");
      result.selection = {
        sameNode: selectedNode === selection.pre.firstChild,
        selectedText,
        during: selection.pre.textContent,
      };
      document.getSelection().removeAllRanges();
      await settle();
      result.selection.after = selection.pre.textContent;
      selection.close();

      const hold = create();
      await hold.write("held");
      const heldNode = hold.pre.firstChild;
      hold.pre.dispatchEvent(
        new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true })
      );
      await hold.write("-updated");
      result.hold = { sameNode: heldNode === hold.pre.firstChild, during: hold.pre.textContent };
      window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch" }));
      await settle();
      result.hold.after = hold.pre.textContent;
      hold.pre.dispatchEvent(
        new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true })
      );
      await hold.write("-cancelled");
      window.dispatchEvent(new PointerEvent("pointercancel", { pointerType: "touch" }));
      await settle();
      result.hold.afterCancel = hold.pre.textContent;
      hold.close();

      const scroll = create();
      await scroll.write(Array.from({ length: 30 }, (_, index) => `line-${index}\r\n`).join(""));
      result.scroll = { followed: scroll.pre.scrollTop > 0 };
      scroll.pre.scrollTop = 0;
      await scroll.write("new-output\r\n");
      result.scroll.afterManualUp = scroll.pre.scrollTop;
      result.scroll.padding = scroll.pre.textContent.includes("line-0\nline-1\n");
      scroll.detach();
      await scroll.write("after-detach");
      result.cleanedUp = !scroll.host.querySelector("[data-android-readonly-log]");
      scroll.term.dispose();
      scroll.host.remove();

      if (measurePerformance) {
        const history = create(96, 10000);
        await history.write(
          Array.from(
            { length: 10000 },
            (_, index) =>
              `\u001b[32m${String(index).padStart(5, "0")}\u001b[0m completed log ${"x".repeat(55)}\r\n`
          ).join("")
        );
        const idleFrames = [];
        for (let index = 0; index < 3; index++) {
          const started = performance.now();
          document.dispatchEvent(new Event("selectionchange"));
          await new Promise(requestAnimationFrame);
          idleFrames.push(performance.now() - started);
        }
        result.performance = {
          bufferRows: history.term.buffer.active.length,
          idleFramesMs: idleFrames,
        };
        history.close();
      }

      document.body.style.cssText =
        "margin:24px;background:#0b1220;color:#dbe7f3;font-family:monospace";
      const title = document.createElement("h1");
      title.style.cssText = "font-size:18px;font-weight:normal";
      title.textContent = "Android selectable log: ANSI / 中文 / emoji / soft wraps";
      document.body.append(title);
      const demo = create(48);
      demo.host.style.height = "260px";
      await demo.write(
        "\u001b[32mSuccess: 中文😀\u001b[0m\r\n" +
          "\u001b[7mInverse text remains visible\u001b[0m\r\n" +
          "https://example.test/continuous-long-path/中文😀/without-copy-line-breaks\r\n" +
          "Read-only text, native selection, no editable field."
      );
      return result;
    },
    { origin, measurePerformance: process.env.READONLY_LOG_PERF === "1" }
  );

  assert.deepEqual(errors, []);
  assert.equal(result.wrap.hasWrappedBufferLine, true);
  assert.equal(result.wrap.overlay, result.wrap.expected);
  assert.deepEqual(result.noneditable, {
    readonly: true,
    inputMode: "none",
    tabIndex: -1,
    layerEditable: false,
  });
  assert.deepEqual(result.colors, {
    inverseForeground: "rgb(11, 18, 32)",
    inverseBackground: "rgb(219, 231, 243)",
    rgb: "rgb(17, 34, 51)",
  });
  assert.notEqual(result.recolor.before, result.recolor.after);
  assert.equal(result.recolor.after, "rgb(204, 0, 0)");
  assert.equal(result.recolor.text, "A\nB\n");
  assert.equal(result.reset.trim(), "");
  assert.deepEqual(result.selection, {
    sameNode: true,
    selectedText: "中文😀A",
    during: "中文😀A\n",
    after: "中文😀A\nnext\n",
  });
  assert.deepEqual(result.hold, {
    sameNode: true,
    during: "held\n",
    after: "held-updated\n",
    afterCancel: "held-updated-cancelled\n",
  });
  assert.deepEqual(result.scroll, { followed: true, afterManualUp: 0, padding: true });
  assert.equal(result.cleanedUp, true);
  await page.screenshot({ path: join(artifacts, "terminal.png"), fullPage: true });
  await writeFile(join(artifacts, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, artifacts, ...result }, null, 2));
} finally {
  await browser.close();
}
