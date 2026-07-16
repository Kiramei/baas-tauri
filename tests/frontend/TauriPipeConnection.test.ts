import { describe, expect, test } from "bun:test";
import {
  TauriPipeConnection,
  type TauriPipeBridge,
} from "../../src/transport/pipe/TauriPipeConnection";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
};

class FakePipeBridge implements TauriPipeBridge {
  readonly open = deferred<string>();
  readonly channelReady = deferred<void>();
  readonly calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  createFailures = 0;
  closeError: Error | null = null;
  cancelRejectsOpen = false;
  framesDuringCreate = 0;
  private onFrame: ((frame: ArrayBuffer | Uint8Array) => void) | null = null;

  createChannel(onMessage: (frame: ArrayBuffer | Uint8Array) => void): unknown {
    if (this.createFailures > 0) {
      this.createFailures -= 1;
      throw new Error("create channel failed");
    }
    this.onFrame = onMessage;
    for (let index = 0; index < this.framesDuringCreate; index += 1) {
      onMessage(encodeFrame(2, new Uint8Array()));
    }
    this.channelReady.resolve();
    return { fakeChannel: true };
  }

  async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, args });
    if (command === "backend_pipe_open") return (await this.open.promise) as T;
    if (command === "backend_pipe_cancel_open" && this.cancelRejectsOpen) {
      this.open.reject(new Error("pipe channel open cancelled during open response read"));
    }
    if (command === "backend_pipe_close" && this.closeError) throw this.closeError;
    return undefined as T;
  }

  send(kind: number, payload: unknown = new Uint8Array()): void {
    if (!this.onFrame) throw new Error("channel is not ready");
    const bytes =
      payload instanceof Uint8Array ? payload : new TextEncoder().encode(JSON.stringify(payload));
    this.onFrame(encodeFrame(kind, bytes));
  }
}

describe("TauriPipeConnection lifecycle", () => {
  test("publishes open before flushing inbound frames in FIFO order", async () => {
    const bridge = new FakePipeBridge();
    const connection = new TauriPipeConnection("provider", "provider-test", async () => bridge);
    const events: string[] = [];
    connection.onOpen = () => events.push("open");

    const connecting = connection.connect((message) => events.push(`message:${message.sequence}`));
    await bridge.channelReady.promise;
    bridge.send(1, { sequence: 1 });
    bridge.send(1, { sequence: 2 });
    expect(events).toEqual([]);

    bridge.open.resolve("41");
    await connecting;
    expect(events).toEqual(["open", "message:1", "message:2"]);
    expect(connection.readyState).toBe(1);
    await connection.sendJson({ request: 1 });
    await connection.sendBytes(new Uint8Array([2, 3]));
    expect(bridge.calls.slice(-2)).toEqual([
      {
        command: "backend_pipe_send_json",
        args: {
          channel: "provider",
          name: "provider-test",
          payload: { request: 1 },
          token: "41",
        },
      },
      {
        command: "backend_pipe_send_bytes",
        args: {
          channel: "provider",
          name: "provider-test",
          payload: [2, 3],
          token: "41",
        },
      },
    ]);
  });

  test("a close during connect actively cancels only its pending client attempt", async () => {
    const bridge = new FakePipeBridge();
    bridge.cancelRejectsOpen = true;
    const connection = new TauriPipeConnection("sync", "shared-name", async () => bridge);
    const events: string[] = [];
    connection.onOpen = () => events.push("open");
    connection.onClose = () => events.push("close");

    const connecting = connection.connect(() => events.push("message"));
    await bridge.channelReady.promise;
    await connection.close();

    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual(["close"]);
    expect(connection.readyState).toBe(3);
    expect(bridge.calls.map((call) => call.command)).toEqual([
      "backend_pipe_open",
      "backend_pipe_cancel_open",
    ]);
    const openAttempt = bridge.calls[0].args.clientAttempt;
    expect(typeof openAttempt).toBe("string");
    expect(String(openAttempt)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(bridge.calls[1].args).toEqual({
      channel: "sync",
      name: "shared-name",
      clientAttempt: openAttempt,
    });
  });

  test("an onOpen close drops queued inbound data and closes the exact token", async () => {
    const bridge = new FakePipeBridge();
    const connection = new TauriPipeConnection("trigger", "trigger-test", async () => bridge);
    const messages: unknown[] = [];
    connection.onOpen = () => void connection.close();

    const connecting = connection.connect((message) => messages.push(message));
    await bridge.channelReady.promise;
    bridge.send(1, { stale: true });
    bridge.open.resolve("91");

    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    expect(messages).toEqual([]);
    expect(
      bridge.calls.filter((call) => call.command === "backend_pipe_close").map((call) => call.args)
    ).toEqual([{ channel: "trigger", name: "trigger-test", token: "91" }]);
  });

  test("delivers at most one terminal notification", async () => {
    const bridge = new FakePipeBridge();
    const connection = new TauriPipeConnection("remote", "remote-test", async () => bridge);
    let closes = 0;
    let errors = 0;
    connection.onClose = () => closes++;
    connection.onError = () => errors++;

    const connecting = connection.connect(() => undefined);
    await bridge.channelReady.promise;
    bridge.open.resolve("123");
    await connecting;
    bridge.send(3);
    bridge.send(4, new TextEncoder().encode("late error"));

    expect(closes).toBe(1);
    expect(errors).toBe(0);
    expect(connection.readyState).toBe(3);
  });

  test("clears connecting after a bridge loader failure so retry and close remain safe", async () => {
    const bridge = new FakePipeBridge();
    let loads = 0;
    const connection = new TauriPipeConnection("provider", "loader-retry", async () => {
      loads += 1;
      if (loads === 1) throw new Error("loader failed");
      return bridge;
    });

    await expect(connection.connect(() => undefined)).rejects.toThrow("loader failed");
    const retry = connection.connect(() => undefined);
    await bridge.channelReady.promise;
    bridge.open.resolve("201");
    await retry;
    await connection.close();

    expect(loads).toBe(2);
    expect(connection.readyState).toBe(3);
    expect(bridge.calls.at(-1)).toEqual({
      command: "backend_pipe_close",
      args: { channel: "provider", name: "loader-retry", token: "201" },
    });
  });

  test("clears connecting after channel construction throws so retry can succeed", async () => {
    const bridge = new FakePipeBridge();
    bridge.createFailures = 1;
    const connection = new TauriPipeConnection("sync", "channel-retry", async () => bridge);

    await expect(connection.connect(() => undefined)).rejects.toThrow("create channel failed");
    const retry = connection.connect(() => undefined);
    await bridge.channelReady.promise;
    bridge.open.resolve("202");
    await retry;
    await connection.close();

    expect(connection.readyState).toBe(3);
    expect(bridge.calls.at(-1)).toEqual({
      command: "backend_pipe_close",
      args: { channel: "sync", name: "channel-retry", token: "202" },
    });
  });

  test("keeps Abort state when exact stale-token cleanup fails", async () => {
    const bridge = new FakePipeBridge();
    const cleanupError = new Error("close invoke failed");
    bridge.closeError = cleanupError;
    const connection = new TauriPipeConnection("remote", "cleanup-failure", async () => bridge);
    let opens = 0;
    connection.onOpen = () => opens++;

    const connecting = connection.connect(() => undefined);
    await bridge.channelReady.promise;
    await connection.close();
    bridge.open.resolve("203");

    try {
      await connecting;
      throw new Error("connect unexpectedly succeeded");
    } catch (error) {
      expect(error).toMatchObject({ name: "AbortError", cause: cleanupError });
    }
    expect(opens).toBe(0);
    expect(connection.readyState).toBe(3);
    expect(bridge.calls.at(-1)).toEqual({
      command: "backend_pipe_close",
      args: { channel: "remote", name: "cleanup-failure", token: "203" },
    });
  });

  test("bounds frames queued before open and fails closed on overflow", async () => {
    const bridge = new FakePipeBridge();
    const connection = new TauriPipeConnection("provider", "queue-limit", async () => bridge);
    const errors: string[] = [];
    connection.onError = (event) => errors.push((event as ErrorEvent).message);

    const connecting = connection.connect(() => undefined);
    await bridge.channelReady.promise;
    for (let index = 0; index <= 256; index += 1) bridge.send(2);
    bridge.open.resolve("204");

    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    expect(errors).toEqual(["Named pipe inbound queue limit exceeded"]);
    expect(connection.readyState).toBe(3);
    expect(bridge.calls.at(-1)).toEqual({
      command: "backend_pipe_close",
      args: { channel: "provider", name: "queue-limit", token: "204" },
    });
  });

  test("a synchronous channel callback can cancel before open is invoked", async () => {
    const bridge = new FakePipeBridge();
    bridge.framesDuringCreate = 257;
    const connection = new TauriPipeConnection("sync", "cancel-before-open", async () => bridge);

    await expect(connection.connect(() => undefined)).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();

    expect(connection.readyState).toBe(3);
    expect(bridge.calls.map((call) => call.command)).toEqual(["backend_pipe_cancel_open"]);
    expect(bridge.calls[0].args).toEqual({
      channel: "sync",
      name: "cancel-before-open",
      clientAttempt: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });
});

function encodeFrame(kind: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(10 + payload.byteLength);
  frame.set([0x42, 0x50, 0x49, 0x50, 1, kind], 0);
  new DataView(frame.buffer).setUint32(6, payload.byteLength, true);
  frame.set(payload, 10);
  return frame;
}
