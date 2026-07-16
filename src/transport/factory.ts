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
  runtime: BackendRuntimeKind = "python",
  runtimeRepositoryGeneration?: string
): Promise<{ baseBackendAddr?: string; baseBackendPort?: number }> {
  if (!__WITH_TAURI__) return {};
  if (__WITH_ANDROID__ && runtime !== "python") {
    throw new Error("Android supports only the Python backend runtime");
  }
  if (runtime === "cpp" && mode !== "websocket") {
    throw new Error("C++ backend runtime supports only WebSocket transport");
  }
  const { invoke } = await import("@/shared/TauriInvoke");
  const selectedMode = resolveBackendSelection(runtime, mode, {
    android: __WITH_ANDROID__,
    tauri: true,
  }).mode;
  return backendTransportStartupCoordinator.start(
    selectedMode,
    runtime,
    {
      getCurrentRuntimeRepositoryGeneration,
      invoke: (command, args) =>
        invoke<{ baseBackendAddr: string; baseBackendPort: number }>(command, args),
    },
    runtimeRepositoryGeneration
  );
}

/** Reads the publisher-selected generation before any C++ process is started. */
export async function getCurrentRuntimeRepositoryGeneration(): Promise<string> {
  if (!__WITH_TAURI__ || __WITH_ANDROID__) {
    throw new Error("Runtime repository generations are available only on desktop");
  }
  const { invoke } = await import("@/shared/TauriInvoke");
  const generation = await invoke<string>("runtime_repository_get_current_generation");
  assertRuntimeRepositoryGeneration(generation);
  return generation;
}

export function assertRuntimeRepositoryGeneration(generation: string): void {
  if (!/^[0-9a-f]{64}$/.test(generation)) {
    throw new Error("Runtime repository generation must be 64 lowercase hexadecimal characters");
  }
}

/** Stable key used to coalesce only starts bound to the same generation. */
export function backendTransportStartupKey(
  mode: BackendTransportMode,
  runtime: BackendRuntimeKind,
  runtimeRepositoryGeneration?: string
): string {
  if (runtime === "cpp") {
    assertRuntimeRepositoryGeneration(runtimeRepositoryGeneration ?? "");
    return `${runtime}:${mode}:${runtimeRepositoryGeneration}`;
  }
  return `${runtime}:${mode}`;
}

export type BackendTransportStartupResult = {
  baseBackendAddr?: string;
  baseBackendPort?: number;
};

export type BackendTransportStartupDependencies = {
  getCurrentRuntimeRepositoryGeneration: () => Promise<string>;
  invoke: (
    command: "backend_transport_start" | "backend_cpp_transport_start",
    args:
      | { mode: BackendTransportMode }
      | { mode: BackendTransportMode; runtimeRepositoryGeneration: string }
  ) => Promise<BackendTransportStartupResult>;
};

/**
 * Process-wide startup serialization. Different keys wait in a loop so every
 * waiter re-checks the active operation after the previous start settles.
 */
export class BackendTransportStartupCoordinator {
  private active: {
    key: string;
    promise: Promise<BackendTransportStartupResult>;
    token: object;
  } | null = null;

  async start(
    mode: BackendTransportMode,
    runtime: BackendRuntimeKind,
    dependencies: BackendTransportStartupDependencies,
    runtimeRepositoryGeneration?: string
  ): Promise<BackendTransportStartupResult> {
    const generation =
      runtime === "cpp"
        ? (runtimeRepositoryGeneration ??
          (await dependencies.getCurrentRuntimeRepositoryGeneration()))
        : undefined;
    const key = backendTransportStartupKey(mode, runtime, generation);

    while (this.active) {
      if (this.active.key === key) return this.active.promise;
      await this.active.promise.catch(() => undefined);
    }

    const invocation = backendTransportStartInvocation(runtime, mode, generation);
    const operation = Promise.resolve().then(() =>
      dependencies.invoke(invocation.command, invocation.args)
    );
    const token = {};
    const tracked = operation.finally(() => {
      if (this.active?.token === token) this.active = null;
    });
    this.active = { key, promise: tracked, token };
    return tracked;
  }
}

const backendTransportStartupCoordinator = new BackendTransportStartupCoordinator();

/** Pure IPC snapshot; the Python shape intentionally stays unchanged. */
export function backendTransportStartInvocation(
  runtime: BackendRuntimeKind,
  mode: BackendTransportMode,
  runtimeRepositoryGeneration?: string
):
  | { command: "backend_transport_start"; args: { mode: BackendTransportMode } }
  | {
      command: "backend_cpp_transport_start";
      args: { mode: BackendTransportMode; runtimeRepositoryGeneration: string };
    } {
  if (runtime === "python") {
    return { command: "backend_transport_start", args: { mode } };
  }
  assertRuntimeRepositoryGeneration(runtimeRepositoryGeneration ?? "");
  return {
    command: "backend_cpp_transport_start",
    args: { mode, runtimeRepositoryGeneration: runtimeRepositoryGeneration! },
  };
}

/** Starts the native service without permitting a Python fallback. */
export function startCppBackendTransport(
  mode: BackendTransportMode
): Promise<{ baseBackendAddr: string; baseBackendPort: number }> {
  return startBackendTransport(mode, "cpp").then((payload) => {
    if (!payload.baseBackendAddr || payload.baseBackendPort === undefined) {
      throw new Error("C++ backend did not return a managed endpoint");
    }
    return {
      baseBackendAddr: payload.baseBackendAddr,
      baseBackendPort: payload.baseBackendPort,
    };
  });
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
