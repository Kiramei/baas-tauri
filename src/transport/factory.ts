import type {
  BackendChannelName,
  BackendChannelOptions,
  BackendConnection,
  BackendControlSessionBundle,
} from "@/transport/types";

export async function startBackendTransport(): Promise<void> {
  if (__WITH_TAURI_MODE__) {
    const { TauriSharedMemoryTransport } = await import(
      "@/transport/tauri-shm/TauriSharedMemoryTransport"
    );
    await new TauriSharedMemoryTransport().start();
    return;
  }
}

export async function openBackendChannel(
  channel: BackendChannelName,
  options: BackendChannelOptions & {
    baseUrl?: string;
    session?: BackendControlSessionBundle | null;
  } = {}
): Promise<BackendConnection> {
  if (__WITH_TAURI_MODE__) {
    const { TauriSharedMemoryTransport } = await import(
      "@/transport/tauri-shm/TauriSharedMemoryTransport"
    );
    const transport = new TauriSharedMemoryTransport();
    return transport.openChannel(channel, options);
  } else {
    if (!options.session) {
      throw new Error("WebSocket transport requires an authenticated session");
    }
    if (!options.baseUrl) {
      throw new Error("WebSocket transport requires a backend base URL");
    }
    const { WebSocketBackendTransport } = await import(
      "@/transport/websocket/WebSocketBackendTransport"
    );
    const transport = new WebSocketBackendTransport(options.baseUrl, options.session);
    return transport.openChannel(channel, options);
  }
}
