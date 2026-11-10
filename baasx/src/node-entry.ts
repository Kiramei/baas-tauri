// Node 20 does not expose a browser-compatible WebSocket globally. Later Node
// versions provide one; keep the fallback confined to the registry bundle.
if (typeof globalThis.WebSocket === "undefined") {
  const { WebSocket } = await import("ws");
  Object.assign(globalThis, { WebSocket });
}

await import("./index");

export {};
