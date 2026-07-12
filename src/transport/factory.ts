import type {
  BackendChannelName,
  BackendChannelOptions,
  BackendConnection,
  BackendControlSessionBundle,
} from "@/transport/types";
import type { TransportMode } from "@/types/app";
import StorageUtil from "@/shared/StorageManager";

export const BACKEND_TRANSPORT_MODE_KEY = "backendTransportMode";

export function normalizeBackendTransportMode(mode?: string | null): TransportMode {
  if (!__WITH_TAURI_MODE__) return "websocket";
  return mode === "websocket" ? "websocket" : "shared-memory";
}

export function getPreferredBackendTransportMode(): TransportMode {
  return normalizeBackendTransportMode(StorageUtil.get<string>(BACKEND_TRANSPORT_MODE_KEY));
}

export function setPreferredBackendTransportMode(mode: TransportMode): TransportMode {
  const normalized = normalizeBackendTransportMode(mode);
  StorageUtil.set(BACKEND_TRANSPORT_MODE_KEY, normalized);
  return normalized;
}

export type BackendTransportStartup = {
  baseBackendAddr?: string;
  baseBackendPort?: number;
};

export async function startBackendTransport(
  mode: TransportMode = getPreferredBackendTransportMode()
): Promise<BackendTransportStartup> {
  const transportMode = normalizeBackendTransportMode(mode);
  if (transportMode === "shared-memory") {
    if (!__WITH_TAURI_MODE__) {
      throw new Error("Shared-memory transport is only available in Tauri mode");
    }
    const { TauriSharedMemoryTransport } = await import(
      "@/transport/tauri-shm/TauriSharedMemoryTransport"
    );
    await new TauriSharedMemoryTransport().start();
    return {};
  }
  if (__WITH_TAURI__) {
    const { invoke } = await import("@tauri-apps/api/core");
    const payload = await invoke<{ baseBackendAddr: string; baseBackendPort: number }>(
      "backend_websocket_start"
    );
    StorageUtil.set("baseBackendAddr", payload.baseBackendAddr);
    StorageUtil.set("baseBackendPort", payload.baseBackendPort);
    return payload;
  }
  return {};
}

export async function openBackendChannel(
  channel: BackendChannelName,
  options: BackendChannelOptions & {
    baseUrl?: string;
    session?: BackendControlSessionBundle | null;
    transportMode?: TransportMode;
  } = {}
): Promise<BackendConnection> {
  const transportMode = normalizeBackendTransportMode(options.transportMode);
  if (transportMode === "shared-memory") {
    if (!__WITH_TAURI_MODE__) {
      throw new Error("Shared-memory transport is only available in Tauri mode");
    }
    const { TauriSharedMemoryTransport } = await import(
      "@/transport/tauri-shm/TauriSharedMemoryTransport"
    );
    const transport = new TauriSharedMemoryTransport();
    return transport.openChannel(channel, options);
  }
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
