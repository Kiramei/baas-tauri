// Development-only Linux WebKitGTK inspector client. The application must start
// with WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:<port> and Vite in tauri mode.
// node scripts/webkit-probe.mjs <port> '<JavaScript expression>'
// The expression may return a Promise; its resolved value is printed as JSON.
const [port, ...expressionParts] = process.argv.slice(2);
if (!/^\d+$/.test(port ?? "") || Number(port) < 1 || Number(port) > 65535) {
  throw new Error("Expected a loopback WebKit inspector port (1–65535)");
}
const expression = expressionParts.join(" ");
if (!expression) throw new Error("Expected a JavaScript expression");
const timeoutMs = Number(process.env.WEBKIT_PROBE_TIMEOUT_MS ?? 600_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
  throw new Error("WEBKIT_PROBE_TIMEOUT_MS must be a positive 32-bit integer");
}

const response = await fetch(`http://127.0.0.1:${port}/`, {
  redirect: "error",
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Inspector HTTP ${response.status}`);
const html = await response.text();
const targets = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].flatMap(([, row]) => {
  const socketPath = row.match(/\/socket\/\d+\/\d+\/[a-z-]+/i)?.[0];
  const url = row.match(/class="targeturl">([^<]*)<\/div>/)?.[1];
  return socketPath && url ? [{ socketPath, url }] : [];
});
const target = targets.find(({ url }) => /^https?:\/\/(?:localhost|127\.0\.0\.1):8191(?:\/|$)/.test(url));
if (!target) throw new Error(`Native Vite WebView target missing: ${JSON.stringify(targets)}`);

const socket = new WebSocket(`ws://127.0.0.1:${port}${target.socketPath}`);
let nextId = 1;
const pending = new Map();
const envelopes = new Map();
let pageTarget;
let resolveTarget, rejectTarget;
const targetReady = new Promise((resolve, reject) => {
  resolveTarget = resolve;
  rejectTarget = reject;
});
const targetTimer = setTimeout(() => rejectTarget(new Error("WebKit page target discovery timed out")), 10_000);
// A connection failure can happen before the main routine awaits targetReady.
targetReady.catch(() => {});

function failPending(error) {
  clearTimeout(targetTimer);
  rejectTarget(error);
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
  envelopes.clear();
}

function dispatch(message) {
  if (message.method === "Target.targetCreated") {
    const info = message.params.targetInfo;
    if (info.type === "page" && !info.isProvisional) {
      pageTarget = info.targetId;
      clearTimeout(targetTimer);
      resolveTarget(pageTarget);
    }
    return;
  }
  if (message.method === "Target.dispatchMessageFromTarget") {
    dispatch(JSON.parse(message.params.message));
    return;
  }
  // Errors in the outer Target envelope belong to the inner request.
  const envelopeId = envelopes.get(message.id);
  if (envelopeId !== undefined) {
    envelopes.delete(message.id);
    if (!message.error) return;
    message = { id: envelopeId, error: message.error };
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
}

socket.addEventListener("message", (event) => {
  try { dispatch(JSON.parse(String(event.data))); }
  catch (error) { failPending(error); }
});
socket.addEventListener("close", () => failPending(new Error("WebKit inspector connection closed")));
socket.addEventListener("error", () => failPending(new Error("WebKit inspector connection failed")));

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`WebKit inspector timeout: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const envelopeId = nextId++;
    envelopes.set(envelopeId, id);
    socket.send(JSON.stringify({
      id: envelopeId,
      method: "Target.sendMessageToTarget",
      params: { targetId: pageTarget, message: JSON.stringify({ id, method, params }) },
    }));
  });
}

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebKit inspector connection timed out")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebKit inspector connection failed")); }, { once: true });
  });
  await targetReady;
  await request("Runtime.enable");
  // WebKit Runtime.evaluate does not have CDP's awaitPromise option. First get
  // the Promise handle, then explicitly ask Runtime.awaitPromise to resolve it.
  const evaluated = await request("Runtime.evaluate", {
    expression: `Promise.resolve().then(() => (${expression}\n))`,
    returnByValue: false,
    emulateUserGesture: true,
  });
  if (evaluated.wasThrown || !evaluated.result?.objectId) {
    throw new Error(evaluated.result?.description ?? "Expression did not produce a Promise");
  }
  const resolved = await request("Runtime.awaitPromise", {
    promiseObjectId: evaluated.result.objectId,
    returnByValue: true,
  });
  if (resolved.wasThrown) throw new Error(resolved.result?.description ?? "Expression rejected");
  console.log(JSON.stringify(resolved.result?.value ?? null, null, 2));
} finally {
  clearTimeout(targetTimer);
  socket.close();
}
