import { describe, expect, test } from "bun:test";
import { resolveTransportMode } from "../../src/transport/factory";

describe("resolveTransportMode", () => {
  test("defaults Windows to shared memory while retaining explicit native pipe for comparison", () => {
    const windows = { android: false, tauri: true, windows: true };
    expect(resolveTransportMode(undefined, windows)).toBe("shm");
    expect(resolveTransportMode("shm", windows)).toBe("shm");
    expect(resolveTransportMode("pipe", windows)).toBe("pipe");
    expect(resolveTransportMode("websocket", windows)).toBe("websocket");
    expect(resolveTransportMode("shm", { android: true, tauri: true })).toBe("pipe");
    expect(resolveTransportMode("shm", { android: false, tauri: false })).toBe("websocket");
  });
  test("prefers Pipe on native clients unless WebSocket is explicitly selected", () => {
    for (const android of [false, true]) {
      const native = { android, tauri: true };
      expect(resolveTransportMode(undefined, native)).toBe("pipe");
      expect(resolveTransportMode("pipe", native)).toBe("pipe");
      expect(resolveTransportMode("websocket", native)).toBe("websocket");
    }
  });

  test("forces WebSocket for WebUI", () => {
    expect(resolveTransportMode("pipe", { android: false, tauri: false })).toBe("websocket");
    expect(resolveTransportMode("pipe", { android: true, tauri: false })).toBe("websocket");
  });
});
