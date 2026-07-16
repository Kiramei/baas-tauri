import { describe, expect, test } from "bun:test";
import {
  backendTransportStartCommand,
  backendTransportStartupKey,
  backendTransportStartInvocation,
  assertRuntimeRepositoryGeneration,
  resolveBackendRuntime,
  resolveBackendSelection,
  resolveTransportMode,
} from "../../src/transport/factory";

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

  test("couples desktop C++ runtime to WebSocket without changing Python defaults", () => {
    const desktop = { android: false, tauri: true };
    expect(resolveBackendSelection(undefined, undefined, desktop)).toEqual({
      runtime: "python",
      mode: "pipe",
    });
    expect(resolveBackendSelection("cpp", "pipe", desktop)).toEqual({
      runtime: "cpp",
      mode: "websocket",
    });
    expect(resolveBackendSelection("cpp", "websocket", desktop)).toEqual({
      runtime: "cpp",
      mode: "websocket",
    });
  });

  test("keeps Android and WebUI on Python even if persisted input requests C++", () => {
    expect(resolveBackendRuntime("cpp", { android: true, tauri: true })).toBe("python");
    expect(resolveBackendRuntime("cpp", { android: false, tauri: false })).toBe("python");
  });

  test("requires one canonical generation for every C++ startup key", () => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    expect(backendTransportStartupKey("websocket", "cpp", first)).toBe(`cpp:websocket:${first}`);
    expect(backendTransportStartupKey("websocket", "cpp", second)).not.toBe(
      backendTransportStartupKey("websocket", "cpp", first)
    );
    expect(() => backendTransportStartupKey("websocket", "cpp")).toThrow(
      "64 lowercase hexadecimal"
    );
    expect(() => assertRuntimeRepositoryGeneration("A".repeat(64))).toThrow(
      "64 lowercase hexadecimal"
    );
  });

  test("keeps Python startup coalescing independent of repository generations", () => {
    expect(backendTransportStartupKey("pipe", "python")).toBe("python:pipe");
    expect(backendTransportStartupKey("pipe", "python", "not-consulted")).toBe("python:pipe");
  });

  test("freezes the legacy Python IPC payload while binding C++ to a generation", () => {
    expect(backendTransportStartInvocation("python", "pipe")).toEqual({
      command: "backend_transport_start",
      args: { mode: "pipe" },
    });
    const generation = "c".repeat(64);
    expect(backendTransportStartInvocation("cpp", "websocket", generation)).toEqual({
      command: "backend_cpp_transport_start",
      args: { mode: "websocket", runtimeRepositoryGeneration: generation },
    });
  });
});
