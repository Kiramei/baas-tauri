import { describe, expect, test } from "bun:test";
import {
  backendTransportStartCommand,
  BackendTransportStartupCoordinator,
  backendTransportStartupKey,
  backendTransportStartInvocation,
  assertRuntimeRepositoryGeneration,
  resolveBackendRuntime,
  resolveBackendSelection,
  resolveTransportMode,
} from "../../src/transport/factory";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

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

  test("coalesces concurrent starts with the same generation into one IPC", async () => {
    const coordinator = new BackendTransportStartupCoordinator();
    const generation = "d".repeat(64);
    const gate = deferred<{ baseBackendAddr: string; baseBackendPort: number }>();
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const dependencies = {
      getCurrentRuntimeRepositoryGeneration: async () => generation,
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        return gate.promise;
      },
    };

    const first = coordinator.start("websocket", "cpp", dependencies);
    const second = coordinator.start("websocket", "cpp", dependencies);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    gate.resolve({ baseBackendAddr: "127.0.0.1", baseBackendPort: 8190 });
    expect(await Promise.all([first, second])).toEqual([
      { baseBackendAddr: "127.0.0.1", baseBackendPort: 8190 },
      { baseBackendAddr: "127.0.0.1", baseBackendPort: 8190 },
    ]);
  });

  test("re-checks after a different key so multiple waiters start only once", async () => {
    const coordinator = new BackendTransportStartupCoordinator();
    const firstGeneration = "e".repeat(64);
    const nextGeneration = "f".repeat(64);
    const firstGate = deferred<{ baseBackendAddr: string; baseBackendPort: number }>();
    const nextGate = deferred<{ baseBackendAddr: string; baseBackendPort: number }>();
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const dependencies = {
      getCurrentRuntimeRepositoryGeneration: async () => {
        throw new Error("explicit generations must not query current");
      },
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        return calls.length === 1 ? firstGate.promise : nextGate.promise;
      },
    };

    const first = coordinator.start("websocket", "cpp", dependencies, firstGeneration);
    const nextOne = coordinator.start("websocket", "cpp", dependencies, nextGeneration);
    const nextTwo = coordinator.start("websocket", "cpp", dependencies, nextGeneration);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    firstGate.resolve({ baseBackendAddr: "127.0.0.1", baseBackendPort: 8190 });
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual({
      mode: "websocket",
      runtimeRepositoryGeneration: nextGeneration,
    });

    nextGate.resolve({ baseBackendAddr: "127.0.0.1", baseBackendPort: 8191 });
    expect(await Promise.all([nextOne, nextTwo])).toEqual([
      { baseBackendAddr: "127.0.0.1", baseBackendPort: 8191 },
      { baseBackendAddr: "127.0.0.1", baseBackendPort: 8191 },
    ]);
    expect(calls).toHaveLength(2);
  });

  test("Python starts never query current and keep the legacy payload", async () => {
    const coordinator = new BackendTransportStartupCoordinator();
    let generationReads = 0;
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const result = await coordinator.start("pipe", "python", {
      getCurrentRuntimeRepositoryGeneration: async () => {
        generationReads += 1;
        return "0".repeat(64);
      },
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        return { baseBackendAddr: "127.0.0.1", baseBackendPort: 8190 };
      },
    });

    expect(result).toEqual({ baseBackendAddr: "127.0.0.1", baseBackendPort: 8190 });
    expect(generationReads).toBe(0);
    expect(calls).toEqual([{ command: "backend_transport_start", args: { mode: "pipe" } }]);
    expect(calls[0]?.args).not.toHaveProperty("runtimeRepositoryGeneration");
  });
});
