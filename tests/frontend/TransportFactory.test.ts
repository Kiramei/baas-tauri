import { describe, expect, test } from "bun:test";
import { resolveTransportMode } from "../../src/transport/factory";

describe("resolveTransportMode", () => {
  test("prefers Pipe on desktop unless WebSocket is explicitly selected", () => {
    const desktop = { android: false, tauri: true };
    expect(resolveTransportMode(undefined, desktop)).toBe("pipe");
    expect(resolveTransportMode("pipe", desktop)).toBe("pipe");
    expect(resolveTransportMode("websocket", desktop)).toBe("websocket");
  });

  test("forces WebSocket for WebUI and Android", () => {
    expect(resolveTransportMode("pipe", { android: false, tauri: false })).toBe("websocket");
    expect(resolveTransportMode("pipe", { android: true, tauri: true })).toBe("websocket");
  });
});
