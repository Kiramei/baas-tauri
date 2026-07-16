import { SecureWebSocket } from "@/shared/SecureWebSocket";
import type {
  BackendChannelName,
  BackendConnection,
  BackendControlSessionBundle,
  BackendRuntimeKind,
  BackendTransportMode,
} from "@/transport/types";

export function normalizeTransportMode(value: unknown): BackendTransportMode {
  return resolveTransportMode(value, {
    android: __WITH_ANDROID__,
    tauri: __WITH_TAURI__,
  });
}

export function resolveTransportMode(
  value: unknown,
  environment: { android: boolean; tauri: boolean }
): BackendTransportMode {
  if (!environment.tauri) return "websocket";
  return value === "websocket" ? "websocket" : "pipe";
}

export async function configuredTransportMode(): Promise<BackendTransportMode> {
  if (!__WITH_TAURI__) return "websocket";
  try {
    const { invoke } = await import("@/shared/TauriInvoke");
    const startup = await invoke<any>("updater_get_startup_state");
    return normalizeTransportMode(startup?.config?.general?.transport);
  } catch {
    return "pipe";
  }
}

export async function startBackendTransport(
  mode: BackendTransportMode,
  runtime: BackendRuntimeKind = "python"
): Promise<{ baseBackendAddr?: string; baseBackendPort?: number }> {
  if (!__WITH_TAURI__) return {};
  const { invoke } = await import("@/shared/TauriInvoke");
  return invoke<{ baseBackendAddr: string; baseBackendPort: number }>(
    backendTransportStartCommand(runtime),
    {
      mode: normalizeTransportMode(mode),
    }
  );
}

/** Explicit native-service opt-in; normal startup remains on the Python backend. */
export function startCppBackendTransport(
  mode: BackendTransportMode
): Promise<{ baseBackendAddr?: string; baseBackendPort?: number }> {
  return startBackendTransport(mode, "cpp");
}

export function backendTransportStartCommand(
  runtime: BackendRuntimeKind
): "backend_transport_start" | "backend_cpp_transport_start" {
  switch (runtime) {
    case "python":
      return "backend_transport_start";
    case "cpp":
      return "backend_cpp_transport_start";
    default:
      throw new Error(`Unsupported backend runtime: ${String(runtime)}`);
  }
}

export async function openBackendChannel(options: {
  mode: BackendTransportMode;
  channel: BackendChannelName;
  name: string;
  baseUrl?: string;
  session?: BackendControlSessionBundle | null;
}): Promise<BackendConnection> {
  if (options.mode === "pipe") {
    const { TauriPipeConnection } = await import("@/transport/pipe/TauriPipeConnection");
    return new TauriPipeConnection(options.channel, options.name);
  }
  if (!options.baseUrl || !options.session) {
    throw new Error("WebSocket transport requires an authenticated session");
  }
  return new SecureWebSocket(
    `${options.baseUrl}/ws/${options.channel}`,
    options.name,
    options.session,
    "arraybuffer"
  );
}
