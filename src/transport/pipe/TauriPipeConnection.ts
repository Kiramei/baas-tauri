import type { BackendChannelName, BackendConnection } from "@/transport/types";
import { Channel, invoke } from "@tauri-apps/api/core";

const HEADER_BYTES = 10;
const MAGIC = [0x42, 0x50, 0x49, 0x50] as const;
const VERSION = 1;
const KIND_JSON = 1;
const KIND_BYTES = 2;
const KIND_CLOSE = 3;
const KIND_ERROR = 4;
const decoder = new TextDecoder();

export class TauriPipeConnection implements BackendConnection {
  readyState = 0;
  onOpen?: BackendConnection["onOpen"];
  onClose?: BackendConnection["onClose"];
  onError?: BackendConnection["onError"];
  hookClose?: () => void;
  private closed = false;
  private receivedFrames = 0;

  constructor(
    private readonly channel: BackendChannelName,
    private readonly name: string
  ) {}

  async connect(
    onMessage: (message: any) => void,
    decodeJson = true,
    _decrypt = true
  ): Promise<void> {
    const subscription = new Channel<ArrayBuffer>((raw) => {
      try {
        const { kind, payload } = decodeFrame(raw);
        this.receivedFrames += 1;
        if (this.receivedFrames <= 3) {
          console.info(
            `[transport] pipe frame channel=${this.channel} kind=${kind} bytes=${payload.byteLength}`
          );
        }
        if (kind === KIND_JSON) {
          const value = JSON.parse(decoder.decode(payload));
          if (this.receivedFrames <= 3) {
            console.info(`[transport] pipe message channel=${this.channel} type=${value?.type}`);
          }
          onMessage(decodeJson ? value : payload.buffer.slice(0));
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
        const detail = error instanceof Error ? error.message : String(error);
        this.onError?.(new ErrorEvent("error", { message: detail }));
      }
    });
    await invoke("backend_pipe_open", {
      channel: this.channel,
      name: this.name,
      onMessage: subscription,
    });
    this.readyState = 1;
    this.onOpen?.(new Event("open"));
  }

  async sendJson(payload: Record<string, unknown>): Promise<void> {
    await invoke("backend_pipe_send_json", {
      channel: this.channel,
      name: this.name,
      payload,
    });
  }

  async sendBytes(payload: ArrayBuffer | Uint8Array): Promise<void> {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    await invoke("backend_pipe_send_bytes", {
      channel: this.channel,
      name: this.name,
      payload: Array.from(bytes),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await invoke("backend_pipe_close", { channel: this.channel, name: this.name });
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

function decodeFrame(raw: ArrayBuffer | Uint8Array): { kind: number; payload: Uint8Array } {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength < HEADER_BYTES) throw new Error("Truncated named pipe frame");
  if (MAGIC.some((value, index) => bytes[index] !== value) || bytes[4] !== VERSION) {
    throw new Error("Invalid named pipe frame header");
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(6, true);
  if (length !== bytes.byteLength - HEADER_BYTES)
    throw new Error("Invalid named pipe frame length");
  return { kind: bytes[5], payload: bytes.subarray(HEADER_BYTES) };
}
