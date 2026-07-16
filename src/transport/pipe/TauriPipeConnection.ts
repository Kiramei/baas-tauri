import type { BackendChannelName, BackendConnection } from "@/transport/types";

const HEADER_BYTES = 10;
const MAGIC = [0x42, 0x50, 0x49, 0x50] as const;
const VERSION = 1;
const KIND_JSON = 1;
const KIND_BYTES = 2;
const KIND_CLOSE = 3;
const KIND_ERROR = 4;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_QUEUED_FRAMES = 256;
const MAX_QUEUED_BYTES = MAX_PAYLOAD_BYTES + HEADER_BYTES;
const decoder = new TextDecoder();

type PipeFrame = ArrayBuffer | Uint8Array;

export interface TauriPipeBridge {
  createChannel(onMessage: (frame: PipeFrame) => void): unknown;
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
}

export type TauriPipeBridgeLoader = () => Promise<TauriPipeBridge>;

const loadTauriPipeBridge: TauriPipeBridgeLoader = async () => {
  const { Channel, invoke } = await import("@tauri-apps/api/core");
  return {
    createChannel: (onMessage) => new Channel<ArrayBuffer>(onMessage),
    invoke: (command, args) => invoke(command, args),
  };
};

export class TauriPipeConnection implements BackendConnection {
  readyState = 0;
  onOpen?: BackendConnection["onOpen"];
  onClose?: BackendConnection["onClose"];
  onError?: BackendConnection["onError"];
  hookClose?: () => void;
  private closed = false;
  private closeNotified = false;
  private connecting = false;
  private attempt = 0;
  private receivedFrames = 0;
  private serverToken: string | null = null;
  private bridge: TauriPipeBridge | null = null;
  private readonly cleanupTasks = new Map<string, Promise<void>>();

  constructor(
    private readonly channel: BackendChannelName,
    private readonly name: string,
    private readonly bridgeLoader: TauriPipeBridgeLoader = loadTauriPipeBridge
  ) {}

  async connect(
    onMessage: (message: any) => void,
    decodeJson = true,
    _decrypt = true
  ): Promise<void> {
    if (this.closed) throw abortedConnectionError();
    if (this.connecting || this.readyState === 1) {
      throw new Error("Named pipe connection is already active");
    }

    const attempt = ++this.attempt;
    this.connecting = true;
    const inbound: PipeFrame[] = [];
    let inboundBytes = 0;
    let opened = false;
    let draining = false;

    const drainInbound = () => {
      if (!opened || draining || this.closed || this.attempt !== attempt) return;
      draining = true;
      try {
        while (inbound.length > 0 && !this.closed && this.attempt === attempt) {
          const frame = inbound.shift()!;
          inboundBytes -= frame.byteLength;
          this.dispatchFrame(frame, onMessage, decodeJson, attempt);
        }
        if (this.closed || this.attempt !== attempt) {
          inbound.length = 0;
          inboundBytes = 0;
        }
      } finally {
        draining = false;
      }
    };

    try {
      const bridge = await this.bridgeLoader();
      if (this.closed || this.attempt !== attempt) throw abortedConnectionError();
      this.bridge = bridge;
      const subscription = bridge.createChannel((raw) => {
        if (this.closed || this.attempt !== attempt) return;
        if (
          inbound.length >= MAX_QUEUED_FRAMES ||
          raw.byteLength > MAX_QUEUED_BYTES ||
          inboundBytes > MAX_QUEUED_BYTES - raw.byteLength
        ) {
          this.emitError("Named pipe inbound queue limit exceeded");
          void this.close().catch((closeError) => {
            console.error("[transport] failed to close overflowing pipe connection", closeError);
          });
          return;
        }
        inbound.push(raw);
        inboundBytes += raw.byteLength;
        drainInbound();
      });

      const serverToken = await bridge.invoke<string>("backend_pipe_open", {
        channel: this.channel,
        name: this.name,
        onMessage: subscription,
      });
      if (this.closed || this.attempt !== attempt) {
        await this.closeServerToken(serverToken, bridge);
        throw abortedConnectionError();
      }

      this.serverToken = serverToken;
      this.connecting = false;
      this.readyState = 1;
      try {
        this.onOpen?.(new Event("open"));
      } catch (error) {
        console.error("[transport] pipe onOpen callback failed", error);
      }
      opened = true;

      if (this.closed || this.attempt !== attempt) {
        inbound.length = 0;
        inboundBytes = 0;
        await this.closeServerToken(serverToken, bridge);
        throw abortedConnectionError();
      }
      drainInbound();
    } catch (error) {
      if (this.attempt === attempt) this.connecting = false;
      if (this.closed || this.attempt !== attempt) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw abortedConnectionError(error);
      }
      throw error;
    }
  }

  async sendJson(payload: Record<string, unknown>): Promise<void> {
    const { bridge, token } = this.requireOpenConnection();
    await bridge.invoke("backend_pipe_send_json", {
      channel: this.channel,
      name: this.name,
      payload,
      token,
    });
  }

  async sendBytes(payload: ArrayBuffer | Uint8Array): Promise<void> {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const { bridge, token } = this.requireOpenConnection();
    await bridge.invoke("backend_pipe_send_bytes", {
      channel: this.channel,
      name: this.name,
      payload: Array.from(bytes),
      token,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connecting = false;
    this.attempt += 1;
    const token = this.serverToken;
    this.serverToken = null;
    try {
      // A close issued while open is still pending is completed by connect(): only
      // the Rust-assigned token can safely close that result without touching a
      // newer connection that happens to reuse the same channel/name key.
      if (token) await this.closeServerToken(token, this.bridge);
    } finally {
      this.finishClose();
    }
  }

  private requireOpenConnection(): { bridge: TauriPipeBridge; token: string } {
    if (this.closed || this.readyState !== 1 || !this.bridge || !this.serverToken) {
      throw new Error("Named pipe connection is not open");
    }
    return { bridge: this.bridge, token: this.serverToken };
  }

  private dispatchFrame(
    raw: PipeFrame,
    onMessage: (message: any) => void,
    decodeJson: boolean,
    attempt: number
  ): void {
    if (this.closed || this.attempt !== attempt) return;
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
        onMessage(
          decodeJson
            ? value
            : payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
        );
      } else if (kind === KIND_BYTES) {
        onMessage(
          payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
        );
      } else if (kind === KIND_CLOSE) {
        this.finishClose();
      } else if (kind === KIND_ERROR) {
        const detail = decoder.decode(payload) || "Named pipe transport failed";
        this.emitError(detail);
        this.finishClose();
      } else {
        throw new Error(`Unsupported named pipe frame kind: ${kind}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.emitError(detail);
      void this.close().catch((closeError) => {
        console.error("[transport] failed to close rejected pipe connection", closeError);
      });
    }
  }

  private closeServerToken(token: string, bridge: TauriPipeBridge | null): Promise<void> {
    const pending = this.cleanupTasks.get(token);
    if (pending) return pending;
    const cleanup = (async () => {
      const activeBridge = bridge ?? (await this.bridgeLoader());
      await activeBridge.invoke("backend_pipe_close", {
        channel: this.channel,
        name: this.name,
        token,
      });
    })();
    this.cleanupTasks.set(token, cleanup);
    void cleanup.then(
      () => {
        if (this.cleanupTasks.get(token) === cleanup) this.cleanupTasks.delete(token);
      },
      () => {
        if (this.cleanupTasks.get(token) === cleanup) this.cleanupTasks.delete(token);
      }
    );
    return cleanup;
  }

  private emitError(detail: string): void {
    try {
      this.onError?.(new ErrorEvent("error", { message: detail }));
    } catch (error) {
      console.error("[transport] pipe onError callback failed", error);
    }
  }

  private finishClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.closed = true;
    this.connecting = false;
    this.serverToken = null;
    this.attempt += 1;
    this.readyState = 3;
    try {
      this.hookClose?.();
    } catch (error) {
      console.error("[transport] pipe hookClose callback failed", error);
    }
    try {
      this.onClose?.(new CloseEvent("close"));
    } catch (error) {
      console.error("[transport] pipe onClose callback failed", error);
    }
  }
}

function abortedConnectionError(cause?: unknown): Error {
  const error = new Error("Named pipe connection closed while connecting");
  error.name = "AbortError";
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
  return error;
}

function decodeFrame(raw: PipeFrame): { kind: number; payload: Uint8Array } {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength < HEADER_BYTES) throw new Error("Truncated named pipe frame");
  if (MAGIC.some((value, index) => bytes[index] !== value) || bytes[4] !== VERSION) {
    throw new Error("Invalid named pipe frame header");
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(6, true);
  if (length > MAX_PAYLOAD_BYTES) throw new Error("Named pipe payload exceeds the 64 MiB limit");
  if (length !== bytes.byteLength - HEADER_BYTES)
    throw new Error("Invalid named pipe frame length");
  return { kind: bytes[5], payload: bytes.subarray(HEADER_BYTES) };
}
