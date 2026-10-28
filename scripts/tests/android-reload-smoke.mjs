// Run against an idle, debug-enabled Android APK after the startup smoke test.
// Reloads the real WebView three times; the backend must stay in one process.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const [serial, packageName = "io.github.kiramei.baas_tauri"] = process.argv.slice(2);
assert(serial, "Specify device serial");
const adb = (...args) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 15000 });
const mainPid = adb("shell", "pidof", packageName).trim();
const backendPid = adb("shell", "pidof", `${packageName}:baas_backend`).trim();
assert(/^\d+$/.test(mainPid) && /^\d+$/.test(backendPid), "Expected exactly one UI and backend process");
adb("forward", "tcp:19223", `localabstract:webview_devtools_remote_${mainPid}`);
try {
  const pages = await (await fetch("http://127.0.0.1:19223/json")).json();
  const page = pages.find(page => page.type === "page" && page.webSocketDebuggerUrl);
  assert(page, "No debuggable app WebView");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const send = (method, params = {}) => socket.send(JSON.stringify({ id: ++id, method, params }));
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { socket.removeEventListener("message", observe); reject(new Error(`CDP timed out: ${method}`)); }, 10000);
    function observe(event) {
      const message = JSON.parse(event.data);
      if (message.id !== requestId) return;
      clearTimeout(timer); socket.removeEventListener("message", observe);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
    socket.addEventListener("message", observe);
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  await request("Page.enable");
  await request("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__baasReloadVisual = { animationFrames: 0, blankFrames: 0 };
    function checkFrame() {
      const trace = window.__baasReloadVisual;
      const shell = document.getElementById('baas-startup-shell');
      if (shell && parseFloat(getComputedStyle(shell).opacity) > 0) trace.animationFrames++;
      else {
        const overlay = document.querySelector('[class~="z-100"]');
        if (overlay && parseFloat(getComputedStyle(overlay).opacity) > 0 && !overlay.innerText.trim()) trace.blankFrames++;
      }
      requestAnimationFrame(checkFrame);
    }
    requestAnimationFrame(checkFrame);
  ` });
  send("Runtime.enable");
  // Drain console history before installing a new per-reload observer.
  await new Promise(resolve => setTimeout(resolve, 200));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = performance.now();
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.removeEventListener("message", observe); reject(new Error(`Reload ${attempt} did not render Home within 30s`)); }, 30000);
      function observe(event) {
        const message = JSON.parse(event.data);
        if (message.method === "Runtime.exceptionThrown") {
          clearTimeout(timer); socket.removeEventListener("message", observe);
          reject(new Error(JSON.stringify(message.params.exceptionDetails)));
        }
        if (message.method === "Runtime.consoleAPICalled" && message.params.args.some(arg => String(arg.value).includes("__ANDROID_HOME_READY__"))) {
          clearTimeout(timer); socket.removeEventListener("message", observe); resolve();
        }
      }
      socket.addEventListener("message", observe);
    });
    send("Page.reload", { ignoreCache: true });
    await ready;
    const visual = (await request("Runtime.evaluate", { expression: "window.__baasReloadVisual", returnByValue: true })).result.value;
    assert(visual.animationFrames > 0, "Original loading animation was not shown");
    assert.equal(visual.blankFrames, 0, "Empty loading overlay appeared during reload");
    assert.equal(adb("shell", "pidof", packageName).trim(), mainPid, "UI process crashed during reload");
    assert.equal(adb("shell", "pidof", `${packageName}:baas_backend`).trim(), backendPid, "Reload restarted backend");
    const log = adb("shell", "run-as", packageName, "cat", "cache/android-startup.log");
    assert(!/address already in use|Event loop is closed|Unhandled thread exception/.test(log), "Backend lifecycle error detected");
    console.log(JSON.stringify({ attempt, reloadToHomeMs: Math.round(performance.now() - started), mainPid, backendPid, visual }));
  }
  socket.close();
} finally {
  adb("forward", "--remove", "tcp:19223");
}
