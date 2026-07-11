import type {
  BackendChannelName,
  BackendChannelOptions,
  BackendConnection,
  BackendTransport,
} from "@/transport/types";

type IpcMessage = {
  channel: string;
  name: string;
  streamId: number;
  kind: "json" | "bytes" | "close" | "error";
  sequenceNumber: number;
  json?: unknown;
  bytes?: number[];
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
    const subscription = new Channel<IpcMessage>((message) => {
      this.handleMessage(message, onMessage);
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
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("backend_ipc_send_bytes", {
      channel: this.channel,
      name: this.name,
      payload: Array.from(bytes),
    });
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

  private handleMessage(message: IpcMessage, onMessage: (message: any) => void): void {
    if (this.closed) return;
    if (message.kind === "json") {
      onMessage(message.json);
    } else if (message.kind === "bytes") {
      onMessage(new Uint8Array(message.bytes ?? []).buffer);
    } else if (message.kind === "close") {
      this.closed = true;
      this.readyState = 3;
      this.hookClose?.();
      this.onClose?.(new CloseEvent("close"));
    } else if (message.kind === "error") {
      this.onError?.(new Event("error"));
    }
  }
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
