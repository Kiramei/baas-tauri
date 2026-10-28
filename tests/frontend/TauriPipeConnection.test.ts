import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Channel, type InvokeArgs } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { TauriPipeConnection } from "../../src/transport/pipe/TauriPipeConnection";
import { TauriSharedMemoryConnection } from "../../src/transport/shm/TauriSharedMemoryConnection";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalAndroid = Object.getOwnPropertyDescriptor(globalThis, "__WITH_ANDROID__");

beforeEach(() => {
  Object.defineProperty(globalThis, "__WITH_ANDROID__", {
    configurable: true,
    writable: true,
    value: false,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { crypto: globalThis.crypto },
  });
});

afterEach(() => {
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete (globalThis as any).window;
  if (originalAndroid) Object.defineProperty(globalThis, "__WITH_ANDROID__", originalAndroid);
  else delete (globalThis as any).__WITH_ANDROID__;
});

function frame(kind: number, text = ""): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const result = new Uint8Array(10 + payload.length);
  result.set([0x42, 0x50, 0x49, 0x50, 1, kind]);
  new DataView(result.buffer).setUint32(6, payload.length, true);
  result.set(payload, 10);
  return result;
}

function subscription(args: InvokeArgs | undefined): Channel<ArrayBuffer> {
  return (args as { onMessage: Channel<ArrayBuffer> }).onMessage;
}

describe("Tauri pipe delivery", () => {
  test("shared memory uses its own native commands and the same ordered binary bridge", async () => {
    const commands: string[] = [];
    mockIPC((command, args) => {
      commands.push(command);
      if (command === "backend_shm_open") {
        subscription(args).onmessage(frame(1, '{"type":"status"}').buffer);
        return "generation:7";
      }
      if (command === "backend_shm_send_bytes") expect(args).toBeInstanceOf(Uint8Array);
      if (command === "backend_shm_close") expect((args as any).connectionId).toBe("generation:7");
    });
    const connection = new TauriSharedMemoryConnection("provider", "provider");
    const messages: unknown[] = [];
    await connection.connect((message) => messages.push(message));
    await connection.sendBytes(new Uint8Array([0, 255]));
    await connection.close();
    expect(messages).toEqual([{ type: "status" }]);
    expect(commands).toEqual(["backend_shm_open", "backend_shm_send_bytes", "backend_shm_close"]);
  });
  test("closing an in-flight shared-memory open only closes its eventual identity", async () => {
    let resolveOld: (id: string) => void = () => {};
    let opens = 0;
    const closes: string[] = [];
    const sends: string[] = [];
    mockIPC((command, args) => {
      if (command === "backend_shm_open") {
        if (++opens === 1)
          return new Promise<string>((resolve) => {
            resolveOld = resolve;
          });
        return "session-new:1";
      }
      if (command === "backend_shm_close") closes.push((args as any).connectionId);
      if (command === "backend_shm_send_json") sends.push((args as any).connectionId);
    });
    const old = new TauriSharedMemoryConnection("provider", "same");
    const oldOpening = old.connect(() => {});
    await old.close();
    expect(closes).toEqual([]);
    const replacement = new TauriSharedMemoryConnection("provider", "same");
    await replacement.connect(() => {});
    resolveOld("session-old:1");
    await oldOpening;
    await replacement.sendJson({ type: "ping" });
    expect(closes).toEqual(["session-old:1"]);
    expect(sends).toEqual(["session-new:1"]);
    expect(old.readyState).toBe(3);
    expect(replacement.readyState).toBe(1);
  });
  test("shared-memory binary invoke carries the connection identity outside the raw body", async () => {
    mockIPC((command) => (command === "backend_shm_open" ? "session:42" : undefined));
    const internals = (window as any).__TAURI_INTERNALS__;
    const originalInvoke = internals.invoke;
    let observed: unknown;
    internals.invoke = (command: string, args: unknown, options: unknown) => {
      if (command === "backend_shm_send_bytes") observed = options;
      return originalInvoke(command, args, options);
    };
    const connection = new TauriSharedMemoryConnection("remote", "remote-配置");
    await connection.connect(() => {});
    await connection.sendBytes(new Uint8Array([0, 255]));
    expect(observed).toEqual({ headers: { "x-baas-connection-id": "session:42" } });
  });
  test("decodeJson=false returns exactly the payload without parsing or the BPIP header", async () => {
    let onMessage: (raw: ArrayBuffer) => void = () => {};
    mockIPC((command, args) => {
      if (command === "backend_pipe_open") onMessage = subscription(args).onmessage;
    });
    const connection = new TauriPipeConnection("remote", "screen");
    const received: ArrayBuffer[] = [];
    const errors: Event[] = [];
    connection.onError = (event) => errors.push(event);
    await connection.connect((message) => received.push(message), false);
    onMessage(frame(1, "raw utf8 配置").buffer);
    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(received[0])).toBe("raw utf8 配置");
  });

  test("a terminal frame during open cannot reopen the connection or deliver later frames", async () => {
    const closed: string[] = [];
    const before = frame(1, '{"sequence":1}');
    const terminal = frame(3);
    const after = frame(1, '{"sequence":2}');
    const batch = new Uint8Array(before.length + terminal.length + after.length);
    batch.set(before);
    batch.set(terminal, before.length);
    batch.set(after, before.length + terminal.length);
    mockIPC((command, args) => {
      if (command === "backend_pipe_open") {
        expect((args as any).batchFrames).toBe(true);
        subscription(args).onmessage(batch.buffer);
      } else if (command === "backend_pipe_close") closed.push(command);
    });
    const connection = new TauriPipeConnection("provider", "provider");
    let opens = 0;
    let closes = 0;
    connection.onOpen = () => opens++;
    connection.onClose = () => closes++;
    const received: unknown[] = [];
    await connection.connect((message) => received.push(message));
    expect(received).toEqual([{ sequence: 1 }]);
    expect(connection.readyState).toBe(3);
    expect(opens).toBe(0);
    expect(closes).toBe(1);
    expect(closed).toHaveLength(1);
  });

  test("binary sends invoke the existing command with a raw body", async () => {
    const calls: { command: string; args: InvokeArgs | undefined }[] = [];
    mockIPC((command, args) => calls.push({ command, args }));
    await new TauriPipeConnection("remote", "screen").sendBytes(new Uint8Array([0, 255]));
    expect(calls[0].command).toBe("backend_pipe_send_bytes");
    expect(calls[0].args).toBeInstanceOf(Uint8Array);
  });

  test("Android binary invokes use JSON objects rather than unsupported raw IPC", async () => {
    (globalThis as any).__WITH_ANDROID__ = true;
    let observed: any;
    mockIPC((command, args) => {
      if (command === "backend_pipe_send_bytes") observed = JSON.parse(JSON.stringify(args));
    });
    const connection = new TauriPipeConnection("trigger", "trigger-配置");
    await connection.sendBytes(new Uint8Array([0, 66, 255]));
    expect(observed).toEqual({ channel: "trigger", name: "trigger-配置", payload: "AEL/" });
  });

  test("binary command header and bytes stay adjacent before subsequent commands", async () => {
    const sent: string[] = [];
    let finishHeader: () => void = () => {};
    mockIPC((command, args) => {
      if (command === "backend_pipe_send_json") {
        const type = (args as any).payload.type;
        sent.push(type);
        if (type === "import_config")
          return new Promise<void>((resolve) => {
            finishHeader = resolve;
          });
      }
      if (command === "backend_pipe_send_bytes") sent.push("bytes");
    });
    const connection = new TauriPipeConnection("trigger", "trigger");
    const importing = connection.sendJsonWithBytes(
      { type: "import_config" },
      new Uint8Array([80, 75])
    );
    const nextCommand = connection.sendJson({ type: "other_command" });
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(sent).toEqual(["import_config"]);
    finishHeader();
    await Promise.all([importing, nextCommand]);
    expect(sent).toEqual(["import_config", "bytes", "other_command"]);
  });

  test("a consumer failure does not discard following messages in the batch", async () => {
    let onMessage: (raw: ArrayBuffer) => void = () => {};
    mockIPC((command, args) => {
      if (command === "backend_pipe_open") onMessage = subscription(args).onmessage;
    });
    const connection = new TauriPipeConnection("provider", "provider");
    const received: unknown[] = [];
    let errors = 0;
    connection.onError = () => errors++;
    await connection.connect((message) => {
      if (message.sequence === 1) throw new Error("consumer failed");
      received.push(message);
    });
    const first = frame(1, '{"sequence":1}');
    const second = frame(1, '{"sequence":2}');
    const batch = new Uint8Array(first.length + second.length);
    batch.set(first);
    batch.set(second, first.length);
    onMessage(batch.buffer);
    expect(errors).toBe(1);
    expect(received).toEqual([{ sequence: 2 }]);
  });
});
