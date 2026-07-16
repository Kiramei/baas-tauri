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

export function resolveBackendRuntime(
  value: unknown,
  environment: { android: boolean; tauri: boolean }
): BackendRuntimeKind {
  if (!environment.tauri || environment.android) return "python";
  return value === "cpp" ? "cpp" : "python";
}

export function resolveBackendSelection(
  runtimeValue: unknown,
  transportValue: unknown,
  environment: { android: boolean; tauri: boolean }
): { runtime: BackendRuntimeKind; mode: BackendTransportMode } {
  const runtime = resolveBackendRuntime(runtimeValue, environment);
  const mode = resolveTransportMode(transportValue, environment);
  return {
    runtime,
    mode: runtime === "cpp" ? "websocket" : mode,
  };
}

export function resolveTransportMode(
  value: unknown,
  environment: { android: boolean; tauri: boolean }
): BackendTransportMode {
  if (!environment.tauri) return "websocket";
  return value === "websocket" ? "websocket" : "pipe";
}

export async function configuredTransportMode(): Promise<BackendTransportMode> {
  return (await configuredBackendSelection()).mode;
}

/** Reads one persisted runtime/transport snapshot so startup cannot mix revisions. */
export async function configuredBackendSelection(): Promise<{
  runtime: BackendRuntimeKind;
  mode: BackendTransportMode;
}> {
  if (!__WITH_TAURI__) return { runtime: "python", mode: "websocket" };
  try {
    const { invoke } = await import("@/shared/TauriInvoke");
    const startup = await invoke<any>("updater_get_startup_state");
    const general = startup?.config?.general ?? {};
    return resolveBackendSelection(
      general.backend_runtime ?? general.backendRuntime,
      general.transport,
      { android: __WITH_ANDROID__, tauri: true }
    );
  } catch (error) {
    if (__WITH_ANDROID__) {
      return resolveBackendSelection(undefined, undefined, {
        android: true,
        tauri: true,
      });
    }
    throw error;
  }
}

export async function startBackendTransport(
  mode: BackendTransportMode,
  runtime: BackendRuntimeKind = "python"
): Promise<{ baseBackendAddr?: string; baseBackendPort?: number }> {
  if (!__WITH_TAURI__) return {};
  if (__WITH_ANDROID__ && runtime !== "python") {
    throw new Error("Android supports only the Python backend runtime");
  }
  if (runtime === "cpp" && mode !== "websocket") {
    throw new Error("C++ backend runtime supports only WebSocket transport");
  }
  const { invoke } = await import("@/shared/TauriInvoke");
  return invoke<{ baseBackendAddr: string; baseBackendPort: number }>(
    backendTransportStartCommand(runtime),
    {
      mode: resolveBackendSelection(runtime, mode, {
        android: __WITH_ANDROID__,
        tauri: true,
      }).mode,
    }
  );
}

/** Starts the native service without permitting a Python fallback. */
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
