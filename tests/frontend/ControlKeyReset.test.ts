import { describe, expect, spyOn, test } from "bun:test";
import { ControlConnection, type ControlSessionBundle } from "../../src/shared/SecureWebSocket";

type Payload = Record<string, unknown>;

/** Cipher envelopes are opaque here; integration tests cover the real encryption. */
class FixtureChannel {
  requests: Payload[] = [];
  private responses = new Map<string, Payload>();

  encrypt(payload: Payload) {
    this.requests.push(payload);
    return { type: "secure", seq: this.requests.length, ciphertext: "fixture-ciphertext" };
  }

  decrypt(envelope: Payload) {
    const payload = this.responses.get(String(envelope.ciphertext));
    if (!payload) throw new Error("Unknown fixture envelope");
    return payload;
  }

  response(payload: Payload) {
    const ciphertext = `fixture-response-${this.responses.size}`;
    this.responses.set(ciphertext, payload);
    return { type: "secure", seq: this.responses.size, ciphertext };
  }
}

class FixtureSocket {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  failSend = false;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  send(data: string) {
    if (this.failSend) throw new Error("Fixture send failure");
    this.sent.push(data);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "fixture close", wasClean: true } as CloseEvent);
  }

  fail() {
    this.onerror?.(new Event("error"));
  }
}

/** Bypass the handshake to isolate the authenticated control state machine. */
function fixture({ authenticated = true, expired = false } = {}) {
  const socket = new FixtureSocket();
  const channel = new FixtureChannel();
  const control = Reflect.construct(ControlConnection, [
    {
      ws: socket,
      initialized: true,
      pwdEpoch: 7,
      pwdSalt: null,
      argon2: {},
      sharedKey: new Uint8Array(32),
      transcriptHash: new Uint8Array(32),
      preauthChannel: channel,
    },
  ]) as ControlConnection;
  const internals = control as unknown as {
    controlChannel: FixtureChannel | null;
    session: ControlSessionBundle | null;
    bindControlHandlers: () => void;
  };
  if (authenticated) {
    internals.controlChannel = channel;
    internals.session = {
      sessionId: "fixture-authenticated-session",
      resumeTicket: "fixture-ticket",
      pwdEpoch: 7,
      expiresAt: Date.now() / 1000 + (expired ? -1 : 3600),
      masterSecret: new Uint8Array(32),
      resumeSecret: new Uint8Array(32),
    };
    internals.bindControlHandlers();
  }
  const deliver = (payload: Payload) => {
    socket.onmessage?.({ data: JSON.stringify(channel.response(payload)) });
  };
  const acknowledge = () => {
    deliver({
      type: "key_changed",
      request_id: channel.requests[0]?.request_id,
      pwd_epoch: 8,
    });
  };
  return { control, socket, channel, internals, deliver, acknowledge };
}

const exampleKey = "fixture-key-rotation-only";

describe("authenticated control Key reset", () => {
  test("unauthenticated and expired sessions send nothing", async () => {
    for (const options of [{ authenticated: false }, { expired: true }]) {
      const { control, socket, channel } = fixture(options);
      await expect(control.resetKey(exampleKey)).rejects.toThrow("authenticated");
      expect(socket.sent).toEqual([]);
      expect(channel.requests).toEqual([]);
    }
  });

  test("both the authenticated session and encrypted channel must exist", async () => {
    for (const missing of ["session", "controlChannel"] as const) {
      const { control, socket, internals } = fixture();
      internals[missing] = null;
      await expect(control.resetKey(exampleKey)).rejects.toThrow("authenticated");
      expect(socket.sent).toEqual([]);
    }
  });

  test("connecting, closing and closed sockets send nothing", async () => {
    for (const readyState of [WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED]) {
      const { control, socket } = fixture();
      socket.readyState = readyState;
      await expect(control.resetKey(exampleKey)).rejects.toThrow("authenticated");
      expect(socket.sent).toEqual([]);
    }
  });

  test("an empty Key cannot send a request", async () => {
    const { control, socket } = fixture();
    await expect(control.resetKey(" \t ")).rejects.toThrow("required");
    expect(socket.sent).toEqual([]);
  });

  test("only an encrypted envelope goes on the wire", async () => {
    const { control, socket, channel, acknowledge } = fixture();
    const operation = control.resetKey(exampleKey);
    expect(channel.requests).toHaveLength(1);
    expect(channel.requests[0].type).toBe("change_password");
    expect(channel.requests[0].new_password).toBe(exampleKey);
    expect(typeof channel.requests[0].request_id).toBe("string");
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "secure",
      seq: 1,
      ciphertext: "fixture-ciphertext",
    });
    expect(socket.sent[0]).not.toContain(exampleKey);
    expect(socket.sent[0]).not.toContain("new_password");
    acknowledge();
    await operation;
  });

  test("confirmation requires the matching request ID and exact next Key epoch", async () => {
    const { control, channel, deliver, acknowledge } = fixture();
    let succeeded = false;
    const operation = control.resetKey(exampleKey).then(() => {
      succeeded = true;
    });
    const requestId = channel.requests[0].request_id;
    for (const payload of [
      { type: "heartbeat", request_id: requestId, pwd_epoch: 8 },
      { type: "key_changed", request_id: "another-request", pwd_epoch: 8 },
      { type: "key_changed", request_id: requestId, pwd_epoch: 7 },
      { type: "key_changed", request_id: requestId, pwd_epoch: 9 },
      { type: "key_changed", request_id: requestId, pwd_epoch: "8" },
      { type: "key_changed", pwd_epoch: 8 },
    ]) {
      deliver(payload);
      await Promise.resolve();
      expect(succeeded).toBe(false);
    }
    acknowledge();
    await operation;
    expect(succeeded).toBe(true);
  });

  test("a concurrent reset cannot replace the request awaiting confirmation", async () => {
    const { control, socket, acknowledge } = fixture();
    const operation = control.resetKey(exampleKey);
    await expect(control.resetKey("another-fixture-key")).rejects.toThrow("already in progress");
    expect(socket.sent).toHaveLength(1);
    acknowledge();
    await operation;
  });

  test.each(["revoked", "closed", "error", "client-close"])(
    "%s rejects an unconfirmed reset",
    async (event) => {
      const { control, socket, deliver, acknowledge } = fixture();
      const operation = control.resetKey(exampleKey);
      const rejection = operation.catch((error: Error) => error);
      if (event === "revoked") deliver({ type: "auth_revoked", pwd_epoch: 8 });
      else if (event === "closed") socket.close();
      else if (event === "client-close") control.close();
      else socket.fail();
      const failure = await rejection;
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("before confirming");
      // A late ACK cannot turn a rejected operation into success.
      acknowledge();
      await expect(operation).rejects.toThrow("before confirming");
    }
  );

  test("send failures reject and release the pending request", async () => {
    const { control, socket, channel, deliver } = fixture();
    socket.failSend = true;
    await expect(control.resetKey(exampleKey)).rejects.toThrow("could not be sent");
    socket.failSend = false;
    const operation = control.resetKey(exampleKey);
    expect(socket.sent).toHaveLength(1);
    // The failed send already used the first request ID. Only the new one may confirm retry.
    deliver({ type: "key_changed", request_id: channel.requests[1].request_id, pwd_epoch: 8 });
    await expect(operation).resolves.toBeUndefined();
  });

  test("a confirmed reset stays successful when the session is then revoked and closed", async () => {
    const { control, socket, deliver, acknowledge } = fixture();
    const operation = control.resetKey(exampleKey);
    acknowledge();
    deliver({ type: "auth_revoked", pwd_epoch: 8 });
    socket.close();
    await expect(operation).resolves.toBeUndefined();
  });

  test("timeout rejects without waiting in real time, and a late ACK cannot succeed", async () => {
    const { control, deliver, acknowledge, channel } = fixture();
    let fireTimeout: (() => void) | undefined;
    const timer = spyOn(globalThis, "setTimeout").mockImplementationOnce((callback, delay) => {
      expect(delay).toBe(15_000);
      fireTimeout = callback as () => void;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    let operation: Promise<void>;
    try {
      operation = control.resetKey(exampleKey);
    } finally {
      timer.mockRestore();
    }
    const rejection = operation!.catch((error: Error) => error);
    expect(fireTimeout).toBeDefined();
    fireTimeout!();
    const failure = await rejection;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("did not confirm");
    acknowledge();
    await expect(operation!).rejects.toThrow("did not confirm");

    // Timeout must release the pending slot for a later, explicitly submitted reset.
    const retry = control.resetKey(exampleKey);
    deliver({ type: "key_changed", request_id: channel.requests[1].request_id, pwd_epoch: 8 });
    await expect(retry).resolves.toBeUndefined();
  });
});
