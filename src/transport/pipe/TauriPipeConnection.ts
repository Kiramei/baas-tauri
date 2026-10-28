import type { BackendChannelName, BackendConnection } from "@/transport/types";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  decodeFrames,
  encodeAndroidBinaryRequest,
  encodeBinaryRequest,
  KIND_BYTES,
  KIND_CLOSE,
  KIND_ERROR,
  KIND_JSON,
} from "./protocol";
const decoder = new TextDecoder();

export class TauriPipeConnection implements BackendConnection {
  readyState = 0;
  onOpen?: BackendConnection["onOpen"];
  onClose?: BackendConnection["onClose"];
  onError?: BackendConnection["onError"];
  hookClose?: () => void;
  private closed = false;
  private connectionId?: string;
  private opening?: Promise<string | void>;
  private outgoing = Promise.resolve();

  constructor(
    private readonly channel: BackendChannelName,
    private readonly name: string,
    private readonly commands: "backend_pipe" | "backend_shm" = "backend_pipe"
  ) {}

  async connect(
    onMessage: (message: any) => void,
    decodeJson = true,
    _decrypt = true
  ): Promise<void> {
    const subscription = new Channel<ArrayBuffer>((raw) => {
      if (this.closed) return;
      try {
        for (const { kind, payload } of decodeFrames(raw)) {
          if (this.closed) break;
          try {
            if (kind === KIND_JSON) {
              const value = decodeJson ? JSON.parse(decoder.decode(payload)) : undefined;
              onMessage(decodeJson ? value : payload.slice().buffer);
            } else if (kind === KIND_BYTES) {
              onMessage(
                payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
              );
            } else if (kind === KIND_CLOSE) {
              this.finishClose();
            } else if (kind === KIND_ERROR) {
              const detail = decoder.decode(payload) || "Named pipe transport failed";
              this.onError?.(new ErrorEvent("error", { message: detail }));
              this.finishClose();
            }
          } catch (error) {
            // Each frame keeps the previous per-callback failure boundary: a
            // consumer error must not discard later messages in the same batch.
            const detail = error instanceof Error ? error.message : String(error);
            this.onError?.(new ErrorEvent("error", { message: detail }));
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.onError?.(new ErrorEvent("error", { message: detail }));
      }
    });
    this.opening = invoke<string | void>(`${this.commands}_open`, {
      channel: this.channel,
      name: this.name,
      onMessage: subscription,
      batchFrames: true,
    });
    const connectionId = await this.opening;
    if (typeof connectionId === "string") this.connectionId = connectionId;
    if (this.commands === "backend_shm" && !this.connectionId)
      throw new Error("Shared-memory open omitted connection identity");
    if (this.closed) {
      await invoke(`${this.commands}_close`, {
        channel: this.channel,
        name: this.name,
        connectionId: this.connectionId,
      });
      return;
    }
    this.readyState = 1;
    this.onOpen?.(new Event("open"));
  }

  sendJson(payload: Record<string, unknown>): Promise<void> {
    return this.enqueueSend(() => this.invokeJson(payload));
  }

  sendBytes(payload: ArrayBuffer | Uint8Array): Promise<void> {
    return this.enqueueSend(() => this.invokeBytes(payload));
  }

  sendJsonWithBytes(
    payload: Record<string, unknown>,
    bytes: ArrayBuffer | Uint8Array
  ): Promise<void> {
    return this.enqueueSend(async () => {
      await this.invokeJson(payload);
      await this.invokeBytes(bytes);
    });
  }

  private enqueueSend(operation: () => Promise<void>): Promise<void> {
    const pending = this.outgoing.then(operation);
    this.outgoing = pending.catch(() => {});
    return pending;
  }

  private async invokeJson(payload: Record<string, unknown>): Promise<void> {
    await this.opening;
    if (this.closed) throw new Error("Native connection is closed");
    await invoke(`${this.commands}_send_json`, {
      channel: this.channel,
      name: this.name,
      payload,
      connectionId: this.connectionId,
    });
  }

  private async invokeBytes(payload: ArrayBuffer | Uint8Array): Promise<void> {
    await this.opening;
    if (this.closed) throw new Error("Native connection is closed");
    await invoke(
      `${this.commands}_send_bytes`,
      typeof __WITH_ANDROID__ !== "undefined" && __WITH_ANDROID__
        ? encodeAndroidBinaryRequest(this.channel, this.name, payload)
        : encodeBinaryRequest(this.channel, this.name, payload),
      this.connectionId ? { headers: { "x-baas-connection-id": this.connectionId } } : undefined
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      // A shared-memory open may still be in flight. Its continuation closes
      // exactly the returned identity once available, never a replacement route.
      if (this.commands === "backend_shm" && !this.connectionId) return;
      await invoke(`${this.commands}_close`, {
        channel: this.channel,
        name: this.name,
        connectionId: this.connectionId,
      });
    } finally {
      this.finishClose();
    }
  }

  private finishClose(): void {
    if (this.readyState === 3) return;
    this.closed = true;
    this.readyState = 3;
    this.hookClose?.();
    this.onClose?.(new CloseEvent("close"));
  }
}
