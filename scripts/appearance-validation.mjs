// Inspect the real native WebView in a development or release test instance.
// Launch that instance with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9230.
// node scripts/appearance-validation.mjs 9230 snapshot|screenshot <path>|eval <expression>|right-click <x> <y>|key <name>
import { writeFile } from "node:fs/promises";

const [port = "9230", action = "snapshot", ...args] = process.argv.slice(2);
if (!/^\d+$/.test(port)) throw new Error("Expected a local DevTools port");
let target;
const targetDeadline = Date.now() + 10000;
while (!target && Date.now() < targetDeadline) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
      response.json()
    );
    target = targets.find(
      (entry) =>
        entry.type === "page" &&
        /^(https?:\/\/(tauri\.localhost|localhost:8191|127\.0\.0\.1:8191))\//.test(entry.url)
    );
  } catch {
    /* The native WebView may still be starting. */
  }
  if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!target) throw new Error("BAAS native WebView target missing");
const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
  else waiter.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DevTools timeout: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

try {
  if (action === "assets-hover") {
    const testWidth = Number(args[0]);
    let originalWidth;
    if (Number.isFinite(testWidth) && testWidth > 0) {
      const result = await request("Runtime.evaluate", {
        expression: `(() => {const e=document.querySelector('main [data-page][aria-hidden="false"] [data-assets-scroll]');if(!e)throw new Error('Visible assets are missing');const width=e.style.width;e.style.width=Math.min(${testWidth},e.clientWidth)+'px';return width;})()`,
        returnByValue: true,
      });
      originalWidth = result.result?.value;
    }
    try {
      const sample = async () => {
        const result = await request("Runtime.evaluate", {
          expression: `(() => {const e=document.querySelector('main [data-page][aria-hidden="false"] [data-assets-scroll]');if(!e)return null;return {bounds:e.getBoundingClientRect().toJSON(),left:e.scrollLeft,max:e.scrollWidth-e.clientWidth};})()`,
          returnByValue: true,
        });
        return result.result?.value;
      };
      const move = async (position) => {
        const current = await sample();
        if (!current?.bounds.width) throw new Error("Visible assets are missing");
        const { left, right, top, height, width } = current.bounds;
        const x =
          position === "right" ? right - 4 : position === "left" ? left + 4 : left + width / 2;
        await request("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y: top + height / 2,
          button: "none",
          buttons: 0,
        });
      };
      const before = await sample();
      if (!before || before.max <= 1) {
        console.log(
          JSON.stringify({
            skipped: before ? "Assets fit the current window" : "Home is not visible",
            before,
          })
        );
      } else {
        await move("right");
        await new Promise((resolve) => setTimeout(resolve, 500));
        const right = await sample();
        await move("middle");
        const middleBefore = await sample();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const middleAfter = await sample();
        await move("left");
        await new Promise((resolve) => setTimeout(resolve, 500));
        const left = await sample();
        await request("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: 5,
          y: 5,
          button: "none",
          buttons: 0,
        });
        console.log(JSON.stringify({ before, right, middleBefore, middleAfter, left }));
      }
    } finally {
      if (originalWidth !== undefined) {
        await request("Runtime.evaluate", {
          expression: `(() => {const e=document.querySelector('main [data-page][aria-hidden="false"] [data-assets-scroll]');if(e)e.style.width=${JSON.stringify(originalWidth)};})()`,
        });
      }
    }
  } else if (action === "move" || action === "hover") {
    const [x, y] = args.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Pointer coordinates required");
    await request("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
    });
    if (action === "hover") {
      await new Promise((resolve) => setTimeout(resolve, 550));
      const response = await request("Runtime.evaluate", {
        expression: `(() => { const e = document.querySelector('[data-slot="tooltip-content"]'); if (!e) return { tooltip: null }; const s = getComputedStyle(e); return { tooltip: e.textContent, bounds: e.getBoundingClientRect().toJSON(), background: s.backgroundColor, color: s.color, radius: s.borderRadius, font: s.fontFamily }; })()`,
        returnByValue: true,
      });
      console.log(JSON.stringify(response.result?.value));
      if (args[2]) {
        const response = await request("Page.captureScreenshot", { format: "png" });
        await writeFile(args[2], Buffer.from(response.data, "base64"));
      }
    } else console.log(JSON.stringify({ moved: { x, y } }));
  } else if (action === "right-click" || action === "click") {
    const [x, y] = args.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Pointer coordinates required");
    const button = action === "right-click" ? "right" : "left";
    await request("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: button === "right" ? 2 : 1,
      clickCount: 1,
    });
    await request("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: 1,
    });
    console.log(JSON.stringify({ clicked: { x, y, button } }));
  } else if (action === "key") {
    const key = args[0];
    const code = { Escape: 27, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, Tab: 9, Enter: 13 }[
      key
    ];
    if (!code) throw new Error("Unsupported validation key");
    await request("Input.dispatchKeyEvent", { type: "keyDown", key, windowsVirtualKeyCode: code });
    await request("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code });
    console.log(JSON.stringify({ pressed: key }));
  } else if (action === "screenshot") {
    if (!args[0]) throw new Error("Screenshot output path required");
    const response = await request("Page.captureScreenshot", { format: "png" });
    await writeFile(args[0], Buffer.from(response.data, "base64"));
    console.log(JSON.stringify({ screenshot: args[0] }));
  } else {
    const expression =
      action === "eval"
        ? args.join(" ")
        : action === "snapshot"
          ? `(async () => {
      const deadline = performance.now() + 10000;
      while (!window.__TAURI_INTERNALS__ || !document.querySelector('main')) {
        if (performance.now() > deadline) throw new Error('Native workspace did not become ready');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const bounds = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON();
      const root = getComputedStyle(document.documentElement);
      const native = command => window.__TAURI_INTERNALS__.invoke('plugin:window|' + command, { label: 'main' });
      return {
        url: location.href,
        theme: document.documentElement.className,
        viewport: { width: innerWidth, height: innerHeight },
        document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        titlebar: bounds('[data-window-titlebar]'), sidebar: bounds('.app-sidebar'), content: bounds('main'),
        font: { family: getComputedStyle(document.body).fontFamily, size: getComputedStyle(document.body).fontSize },
        colors: Object.fromEntries(['--background', '--sidebar', '--foreground', '--primary', '--border', '--window-titlebar-height'].map(name => [name, root.getPropertyValue(name).trim()])),
        controls: [...document.querySelectorAll('[data-window-titlebar] button')].map(button => button.getAttribute('aria-label')),
        native: { decorated: await native('is_decorated'), maximized: await native('is_maximized'), minimized: await native('is_minimized'), visible: await native('is_visible') }
      };
    })()`
          : null;
    if (!expression) throw new Error(`Unknown action: ${action}`);
    const response = await request("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails)
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
      );
    console.log(JSON.stringify(response.result?.value, null, 2));
  }
} finally {
  socket.close();
}
