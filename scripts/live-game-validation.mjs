// Development-only native WebView probe. Start a test instance with WebView2
// remote debugging bound to loopback and Vite in tauri mode first.
// node scripts/live-game-validation.mjs <port> state|commands|task|mode|remote-start|remote-sample|remote-tap|remote-shot|remote-stop|screenshot [...args]
import { writeFile } from "node:fs/promises";

const [port = "9229", action = "state", ...args] = process.argv.slice(2);
if (!/^\d+$/.test(port)) throw new Error("Expected local DevTools port");
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((entry) => entry.type === "page" && entry.url.includes(":8191"));
if (!target) throw new Error(`Native Vite WebView target missing: ${JSON.stringify(targets.map(({type,url})=>({type,url})))}`);
const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer); pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, 150_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
try {
  if (action === "reload") {
    await request("Page.reload", { ignoreCache: true });
    console.log(JSON.stringify({ reloaded: true }));
  } else if (action === "screenshot") {
    const response = await request("Page.captureScreenshot", { format: "png" });
    await writeFile(args[0], Buffer.from(response.data, "base64"));
    console.log(JSON.stringify({ screenshot: args[0] }));
  } else {
    const number = (index, fallback) => {
      const value = Number(args[index] ?? fallback);
      if (!Number.isFinite(value)) throw new Error(`Expected number at argument ${index}`);
      return value;
    };
    const actions = {
      state: () => "probe.state()",
      locale: () => "await probe.locale()",
      eval: () => args.join(" "),
      logs: () => `probe.logs(${JSON.stringify(args[0])},${number(1, 50)})`,
      commands: () => `await probe.measureCommands(${number(0, 50)})`,
      task: () => `await probe.runTask(${JSON.stringify(args[0])},${JSON.stringify(args[1])})`,
      mode: () => `await probe.switchMode(${JSON.stringify(args[0])})`,
      "remote-start": () => "await probe.startRemote()",
      "remote-sample": () => `await probe.measureRemote(${number(0, 15)})`,
      "remote-region": () => `probe.remoteRegion([${[0,1,2,3].map(index=>number(index,10)).join(",")}])`,
      "remote-tap": () => `await probe.tapAndMeasure(${number(0, 0)},${number(1, 0)},[${[2,3,4,5].map(index=>number(index, 10)).join(",")}],${number(6, 25)})`,
      "remote-shot": () => "probe.remoteScreenshot()",
      "remote-stop": () => "probe.stopRemote() ?? {stopped:true}",
    };
    if (!(action in actions)) throw new Error(`Unknown action: ${action}`);
    const response = await request("Runtime.evaluate", {
      expression: `(async()=>{ const probe=await import('/tests/browser/live-game-probe.ts?live=20261016v1'); return ${actions[action]()}; })()`,
      awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    const result = response.result?.value;
    if (action === "remote-shot") {
      await writeFile(args[0], Buffer.from(result.split(",")[1], "base64"));
      console.log(JSON.stringify({ screenshot: args[0] }));
    } else console.log(JSON.stringify(result, null, 2));
  }
} finally {
  socket.close();
}
