import { describe, expect, test } from "bun:test";
import { canReusePasswordKey, sendJsonAndWaitForMessage } from "../../src/shared/SecureWebSocket";

describe("password KDF reuse", () => {
  test("reuses identical authenticated parameters regardless of JSON key order", () => {
    expect(canReusePasswordKey("salt", { opslimit: 3, memlimit: 64 }, "salt", { memlimit: 64, opslimit: 3 })).toBe(true);
  });

  test("does not reuse a key when salt or any parameter changes", () => {
    const params = { algorithm: "argon2id", opslimit: 3, memlimit: 64 };
    expect(canReusePasswordKey("salt", params, "new-salt", params)).toBe(false);
    expect(canReusePasswordKey(null, params, "salt", params)).toBe(false);
    for (const changed of [
      { ...params, opslimit: 4 },
      { ...params, memlimit: 128 },
      { ...params, algorithm: "other" },
      { ...params, extra: true },
    ]) expect(canReusePasswordKey("salt", params, "salt", changed)).toBe(false);
  });
});

class ImmediateResponseSocket extends EventTarget {
  sent: string[] = [];

  send(payload: string) {
    this.sent.push(payload);
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ok" }) }));
  }
}

describe("sendJsonAndWaitForMessage", () => {
  test("observes a response emitted synchronously by send", async () => {
    const socket = new ImmediateResponseSocket();

    const response = await sendJsonAndWaitForMessage(
      socket as unknown as WebSocket,
      { type: "request" }
    );

    expect(socket.sent).toEqual(['{"type":"request"}']);
    expect(response).toEqual({ type: "ok" });
  });
});
