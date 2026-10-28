import { describe, expect, test } from "bun:test";
import { resolveTransportMode } from "../../src/transport/factory";

describe("resolveTransportMode", () => {
  test("macOS supports shared memory and retains explicit WebSocket preferences", () => {
    for (const mode of [undefined, "pipe", "shm", "websocket"]) {
      expect(resolveTransportMode(mode, { android: false, tauri: true, macos: true })).toBe(
        mode === "websocket" ? "websocket" : "shm"
      );
    }
  });
  test("supports shared memory on native Windows and Linux while retaining explicit alternatives", () => {
    const supported = { android: false, tauri: true, sharedMemory: true };
    expect(resolveTransportMode(undefined, supported)).toBe("shm");
    expect(resolveTransportMode("shm", supported)).toBe("shm");
    expect(resolveTransportMode("pipe", supported)).toBe("pipe");
    expect(resolveTransportMode("websocket", supported)).toBe("websocket");
    expect(resolveTransportMode("shm", { ...supported, android: true })).toBe("pipe");
    expect(resolveTransportMode("shm", { android: true, tauri: true })).toBe("pipe");
    expect(resolveTransportMode("shm", { android: false, tauri: false })).toBe("websocket");
  });
  test("prefers Pipe on native clients unless WebSocket is explicitly selected", () => {
    for (const android of [false, true]) {
      const native = { android, tauri: true };
      expect(resolveTransportMode(undefined, native)).toBe("pipe");
      expect(resolveTransportMode("pipe", native)).toBe("pipe");
      expect(resolveTransportMode("websocket", native)).toBe("websocket");
      expect(resolveTransportMode("shm", native)).toBe("pipe");
    }
  });

  test("forces WebSocket for WebUI", () => {
    expect(resolveTransportMode("pipe", { android: false, tauri: false })).toBe("websocket");
    expect(resolveTransportMode("pipe", { android: true, tauri: false })).toBe("websocket");
  });
});
