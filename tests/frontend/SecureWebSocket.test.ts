import { describe, expect, test } from "bun:test";
import { sendJsonAndWaitForMessage } from "../../src/shared/SecureWebSocket";

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
