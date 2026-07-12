import type {
  BackendChannelName,
  BackendChannelOptions,
  BackendConnection,
  BackendTransport,
} from "@/transport/types";

const WEBVIEW_FRAME_HEADER_BYTES = 20;
const WEBVIEW_FRAME_MAGIC = [0x42, 0x49, 0x50, 0x43] as const;
const WEBVIEW_FRAME_VERSION = 1;
const WEBVIEW_KIND_JSON = 1;
const WEBVIEW_KIND_BYTES = 2;
const WEBVIEW_KIND_CLOSE = 3;
const WEBVIEW_KIND_ERROR = 4;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const WEBVIEW_REQUEST_HEADER_BYTES = 8;
const WEBVIEW_REQUEST_MAGIC = [0x42, 0x49, 0x50, 0x52] as const;
const WEBVIEW_REQUEST_VERSION = 1;
const CHANNEL_IDS: Record<BackendChannelName, number> = {
  provider: 1,
  sync: 2,
  trigger: 3,
  remote: 4,
};

class TauriSharedMemoryConnection implements BackendConnection {
  readyState = 0;
  onOpen?: BackendConnection["onOpen"];
  onClose?: BackendConnection["onClose"];
  onError?: BackendConnection["onError"];
  hookClose?: () => void;
  private closed = false;
  private removeUnloadListener?: () => void;

  constructor(
    private readonly channel: BackendChannelName,
    private readonly name: string
  ) {}

  async connect(onMessage: (message: any) => void): Promise<void> {
    const { Channel, invoke } = await import("@tauri-apps/api/core");
    await invoke("backend_ipc_open_channel", { channel: this.channel, name: this.name });
    const subscription = new Channel<ArrayBuffer>((message) => {
      try {
        this.handleMessage(message, onMessage);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.onError?.(new ErrorEvent("error", { message: detail }));
      }
    });
    await invoke("backend_ipc_subscribe", {
      channel: this.channel,
      name: this.name,
      onMessage: subscription,
    });
    this.readyState = 1;
    this.installUnloadCleanup();
    this.onOpen?.(new Event("open"));
  }

  async sendJson(payload: Record<string, unknown>): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("backend_ipc_send_json", { channel: this.channel, name: this.name, payload });
  }

  async sendBytes(payload: ArrayBuffer | Uint8Array): Promise<void> {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const name = textEncoder.encode(this.name);
    if (name.byteLength > 0xffff) {
      throw new Error("MessageTooLarge: shared-memory channel name exceeds 65535 UTF-8 bytes");
    }
    const request = new Uint8Array(WEBVIEW_REQUEST_HEADER_BYTES + name.byteLength + bytes.byteLength);
    request.set(WEBVIEW_REQUEST_MAGIC, 0);
    request[4] = WEBVIEW_REQUEST_VERSION;
    request[5] = CHANNEL_IDS[this.channel];
    new DataView(request.buffer).setUint16(6, name.byteLength, true);
    request.set(name, WEBVIEW_REQUEST_HEADER_BYTES);
    request.set(bytes, WEBVIEW_REQUEST_HEADER_BYTES + name.byteLength);
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("backend_ipc_send_bytes", request);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.removeUnloadListener?.();
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("backend_ipc_close_channel", { channel: this.channel, name: this.name });
    } catch (error) {
      if (!isPageUnloading()) {
        throw error;
      }
    }
    this.hookClose?.();
  }

  private installUnloadCleanup(): void {
    if (this.removeUnloadListener || typeof window === "undefined") return;
    const closeForUnload = () => {
      void this.close().catch(() => undefined);
    };
    window.addEventListener("pagehide", closeForUnload, { capture: true });
    window.addEventListener("beforeunload", closeForUnload, { capture: true });
    this.removeUnloadListener = () => {
      window.removeEventListener("pagehide", closeForUnload, { capture: true });
      window.removeEventListener("beforeunload", closeForUnload, { capture: true });
      this.removeUnloadListener = undefined;
    };
  }

  private handleMessage(message: ArrayBuffer, onMessage: (message: any) => void): void {
    if (this.closed) return;
    const frame = decodeWebviewFrame(message);
    if (frame.kind === WEBVIEW_KIND_JSON) {
      onMessage(JSON.parse(textDecoder.decode(frame.payload)));
    } else if (frame.kind === WEBVIEW_KIND_BYTES) {
      onMessage(
        frame.payload.buffer.slice(
          frame.payload.byteOffset,
          frame.payload.byteOffset + frame.payload.byteLength
        )
      );
    } else if (frame.kind === WEBVIEW_KIND_CLOSE) {
      this.closed = true;
      this.readyState = 3;
      this.hookClose?.();
      this.onClose?.(new CloseEvent("close"));
    } else if (frame.kind === WEBVIEW_KIND_ERROR) {
      let detail = textDecoder.decode(frame.payload) || "Shared-memory transport failed";
      try {
        const payload = JSON.parse(detail) as { error?: unknown; message?: unknown };
        detail = String(payload.error ?? payload.message ?? detail);
      } catch {
        // Preserve non-JSON transport errors verbatim.
      }
      this.onError?.(new ErrorEvent("error", { message: detail }));
    }
  }
}

function decodeWebviewFrame(buffer: ArrayBuffer): { kind: number; payload: Uint8Array } {
  if (buffer.byteLength < WEBVIEW_FRAME_HEADER_BYTES) {
    throw new Error("SharedMemoryCorrupted: truncated WebView IPC frame");
  }
  const bytes = new Uint8Array(buffer);
  if (WEBVIEW_FRAME_MAGIC.some((value, index) => bytes[index] !== value)) {
    throw new Error("SharedMemoryCorrupted: invalid WebView IPC frame magic");
  }
  if (bytes[4] !== WEBVIEW_FRAME_VERSION) {
    throw new Error(`ProtocolVersionMismatch: unsupported WebView IPC frame version ${bytes[4]}`);
  }
  const view = new DataView(buffer);
  const payloadLength = view.getUint32(16, true);
  if (payloadLength !== buffer.byteLength - WEBVIEW_FRAME_HEADER_BYTES) {
    throw new Error("SharedMemoryCorrupted: invalid WebView IPC payload length");
  }
  return {
    kind: bytes[5],
    payload: bytes.subarray(WEBVIEW_FRAME_HEADER_BYTES),
  };
}

const isPageUnloading = () =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

export class TauriSharedMemoryTransport implements BackendTransport {
  async start(): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("backend_ipc_start");
  }

  async close(): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("backend_ipc_close");
  }

  async openChannel(
    channel: BackendChannelName,
    options: BackendChannelOptions = {}
  ): Promise<BackendConnection> {
    return new TauriSharedMemoryConnection(channel, options.name ?? channel);
  }
}
