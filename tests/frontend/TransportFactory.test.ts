import { describe, expect, test } from "bun:test";
import { backendTransportStartCommand, resolveTransportMode } from "../../src/transport/factory";

describe("resolveTransportMode", () => {
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

  test("keeps Python as the normal entry and exposes C++ only by explicit selection", () => {
    expect(backendTransportStartCommand("python")).toBe("backend_transport_start");
    expect(backendTransportStartCommand("cpp")).toBe("backend_cpp_transport_start");
    expect(() => backendTransportStartCommand("other" as never)).toThrow(
      "Unsupported backend runtime: other"
    );
  });
});
