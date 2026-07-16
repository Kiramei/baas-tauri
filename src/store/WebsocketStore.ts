import { toast } from "sonner";
import { create } from "zustand";
import {
  ControlConnection,
  randomUUID,
  rememberControlSession,
} from "@/shared/SecureWebSocket";
import {
  configuredBackendSelection,
  normalizeTransportMode,
  openBackendChannel,
  startBackendTransport,
} from "@/transport/factory";
import type {
  BackendChannelName,
  BackendConnection,
  BackendRuntimeKind,
} from "@/transport/types";
import { subscribeWithSelector } from "zustand/middleware";
import { getTimestampMs, isPlainObject } from "@/shared/GlobalUtilities.ts";
import { CorrelationIdAllocator } from "@/shared/CorrelationIdAllocator";
import { useGlobalLogStore } from "@/store/GlobalLogStore";
import { t } from "i18next";
import {
  LogItem,
  RawLogItem,
  StatusItem,
  WebSocketState,
  WrappedStatusItem,
  WsCallBackDict,
  WsMessageItem,
  WsName,
} from "@/types/app";
import StorageUtil from "@/shared/StorageManager.ts";
import {
  announceServiceTransportDisconnected,
  transportRecoveryDelay,
} from "@/shared/ServiceTransportEvents";
import { getAndroidAutoPassword } from "@/shared/AndroidAuth";

let activeWebSocketBase: string | null = null;

const resolveBase = () => {
  if (activeWebSocketBase) return activeWebSocketBase;
  if (import.meta.env.VITE_BAAS_WS_BASE) {
    return import.meta.env.VITE_BAAS_WS_BASE as string;
  }
  const storedAddr = StorageUtil.get<string>("baseBackendAddr");
  const storedPort = StorageUtil.get<number | string>("baseBackendPort");
  if (storedAddr && storedPort) {
    return `ws://${storedAddr}:${Number(storedPort)}`;
  }
  if (__WITH_ANDROID__) {
    return "ws://127.0.0.1:8190";
  }
  if (typeof window !== "undefined" && window.location.hostname) {
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${window.location.hostname}:8190`;
  }
  return "ws://127.0.0.1:8190";
};

export const resolveHttpBase = () => {
  const wsBase = resolveBase();
  if (wsBase.startsWith("wss://")) return `https://${wsBase.slice("wss://".length)}`;
  if (wsBase.startsWith("ws://")) return `http://${wsBase.slice("ws://".length)}`;
  return wsBase;
};

const { appendGlobalLog } = useGlobalLogStore.getState();
const UPDATE_CHECK_INTERVAL_MS = 60 * 1000;
const ANDROID_STARTUP_UPDATE_DELAY_MS = 30 * 1000;
let backendUpdaterPollTimer: ReturnType<typeof setInterval> | null = null;
let backendUpdaterPollDelayTimer: ReturnType<typeof setTimeout> | null = null;
let backendUpdaterChecking = false;
let tauriUpdaterPollTimer: ReturnType<typeof setInterval> | null = null;
let tauriUpdaterChecking = false;
let tauriUpdaterNotifiedVersion: string | null = null;
let transportStartupFailureAt = 0;
let transportGeneration = 0;
let transportRecoveryEpoch = 0;
let transportRecoveryPromise: Promise<void> | null = null;
let transportRecoveryMustRestart = false;
let transportRecoveryRestarting = false;
let transportOutageAnnounced = false;
let transportSwitching = false;
const desiredConnectionNames = new Set<WsName>();
const connectionOpenPromises = new Map<WsName, Promise<void>>();
const MAX_SYNC_PATCH_RETRIES = 3;

type PendingSyncPatch = {
  resource: string;
  resourceId: string;
  ops: Array<{ op: string; path: string; value: unknown }>;
  retries: number;
};

const pendingSyncPatches = new Map<number, PendingSyncPatch>();
const correlationIds = new CorrelationIdAllocator();

type CorrelationState = Pick<
  WebSocketState,
  "pendingCallbacks" | "pendingStreamCallbacks" | "pendingBinaryCallbacks"
>;

const ownsCorrelation = (table: Record<string, unknown>, candidate: number) =>
  Object.prototype.hasOwnProperty.call(table, candidate);

/** Reserves one identifier across every response and sync-retry owner. */
const allocateCorrelationId = (state: CorrelationState, minimum = 0) =>
  correlationIds.allocate(
    (candidate) =>
      pendingSyncPatches.has(candidate) ||
      ownsCorrelation(state.pendingCallbacks, candidate) ||
      ownsCorrelation(state.pendingStreamCallbacks, candidate) ||
      ownsCorrelation(state.pendingBinaryCallbacks, candidate),
    minimum
  );

/** Starts through the process-wide coordinator while retaining local cooldown policy. */
const startManagedBackendTransport = async (
  mode: "websocket" | "pipe",
  runtime: BackendRuntimeKind
) => {
  if (Date.now() - transportStartupFailureAt < 5_000) {
    throw new Error("Backend transport startup is cooling down after a failure");
  }
  try {
    const startup = await startBackendTransport(mode, runtime);
    transportStartupFailureAt = 0;
    return startup;
  } catch (error) {
    transportStartupFailureAt = Date.now();
    throw error;
  }
};

export const isTauriNoUpdateEnabled = async (): Promise<boolean> => {
  if (!__WITH_TAURI__) return false;
  try {
    const { invoke } = await import("@/shared/TauriInvoke");
    const startup = await invoke<any>("updater_get_startup_state");
    const general = startup?.config?.general ?? {};
    return Boolean(general.no_update ?? general.noUpdate ?? false);
  } catch {
    return false;
  }
};

const checkBackendUpdater = async () => {
  if (__WITH_TAURI__) {
    if (backendUpdaterChecking) return;
    backendUpdaterChecking = true;
    const resetTimer = setTimeout(() => {
      backendUpdaterChecking = false;
    }, 30_000);
    try {
      const { invoke } = await import("@/shared/TauriInvoke");
      const report = await invoke<any>("updater_check_version", { request: {} });
      clearTimeout(resetTimer);
      backendUpdaterChecking = false;
      useWebSocketStore.setState((state) => ({
        ...state,
        versionStore: {
          ...state.versionStore,
          local: report.local,
          remote: report.remote,
          updateAvailable:
            report.updateAvailable ?? report.update_available ?? report.local !== report.remote,
          channel: report.channel ?? state.versionStore.channel,
          method: report.method ?? state.versionStore.method,
          checking: false,
          lastChecked: Date.now(),
        },
      }));
    } catch (error) {
      clearTimeout(resetTimer);
      backendUpdaterChecking = false;
      appendGlobalLog({
        level: "warning",
        message: `Backend updater check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      } as any);
      useWebSocketStore.setState((state) => ({
        ...state,
        versionStore: {
          ...state.versionStore,
          checking: false,
          error: error instanceof Error ? error.message : String(error),
          lastChecked: Date.now(),
        },
      }));
    }
    return;
  }

  const store = useWebSocketStore.getState();
  if (
    backendUpdaterChecking ||
    store._auth_phase !== "authenticated" ||
    !store.connections.trigger
  ) {
    return;
  }
  backendUpdaterChecking = true;
  const resetTimer = setTimeout(() => {
    backendUpdaterChecking = false;
  }, 30_000);
  store.trigger(
    {
      timestamp: getTimestampMs(),
      command: "check_for_update",
      payload: {},
    },
    (event) => {
      clearTimeout(resetTimer);
      backendUpdaterChecking = false;
      useWebSocketStore.setState((state) => ({
        ...state,
        versionStore: {
          ...state.versionStore,
          local: event.data.local,
          remote: event.data.remote,
          updateAvailable: event.data.update_available ?? event.data.local !== event.data.remote,
          channel: event.data.channel ?? state.versionStore.channel,
          method: event.data.method ?? state.versionStore.method,
          checking: false,
          lastChecked: Date.now(),
        },
      }));
    }
  );
};

const startBackendUpdaterPolling = (initialDelayMs = 0) => {
  if (backendUpdaterPollTimer || backendUpdaterPollDelayTimer) return;

  const beginPolling = () => {
    backendUpdaterPollDelayTimer = null;
    void checkBackendUpdater();
    backendUpdaterPollTimer = setInterval(checkBackendUpdater, UPDATE_CHECK_INTERVAL_MS);
  };

  if (initialDelayMs > 0) {
    backendUpdaterPollDelayTimer = setTimeout(beginPolling, initialDelayMs);
    return;
  }

  beginPolling();
};

const checkAndroidClientUpdate = async (currentVersion?: string) => {
  const { invoke } = await import("@/shared/TauriInvoke");
  return await invoke<any>("tauri_client_check_update", {
    request: {
      currentVersion,
    },
  });
};

const resetConnectionStores = (): Partial<WebSocketState> => ({
  connections: {},
  pendingCallbacks: {},
  pendingStreamCallbacks: {},
  pendingBinaryCallbacks: {},
  pendingBinaryQueue: [],
  _all_data_initialized: false,
  _heartbeat_time: 0,
  _initiating: false,
});

const resetDataStores = (): Partial<WebSocketState> => ({
  ...resetConnectionStores(),
  logStore: {},
  configStore: {},
  staticStore: {},
  eventStore: {},
  updateStore: {},
  statusStore: {},
  versionStore: {},
});

/** Persists the dynamic loopback address returned by the managed backend. */
const applyManagedBackendAddress = (startup: {
  baseBackendAddr?: string;
  baseBackendPort?: number;
}) => {
  if (!startup.baseBackendAddr || !startup.baseBackendPort) return;
  activeWebSocketBase = `ws://${startup.baseBackendAddr}:${startup.baseBackendPort}`;
  StorageUtil.set("baseBackendAddr", startup.baseBackendAddr);
  StorageUtil.set("baseBackendPort", startup.baseBackendPort);
};

/** Invalidates close handlers from the old generation and clears business channels. */
const closeBusinessConnections = (closeControl: boolean): number => {
  transportGeneration += 1;
  const state = useWebSocketStore.getState();
  Object.values(state.connections).forEach((connection) => void connection?.close());
  if (closeControl) state._control?.close();
  useWebSocketStore.setState((current) => ({
    ...current,
    ...resetConnectionStores(),
    ...(closeControl ? { _control: null, _session: null } : {}),
  }));
  return transportGeneration;
};

/** Reopens every core channel that the application had requested. */
const connectDesiredChannels = async () => {
  for (const name of ["provider", "sync", "trigger"] as const) {
    if (desiredConnectionNames.has(name)) {
      await useWebSocketStore.getState().connect(name);
    }
  }
};

/** Restores authentication after a managed backend restart. */
const restoreTransportAuthentication = async (mode: "websocket" | "pipe") => {
  if (mode === "pipe") {
    activeWebSocketBase = null;
    useWebSocketStore.setState({
      _auth_phase: "authenticated",
      _auth_error: null,
      _server_initialized: true,
      _server_verified: true,
      _control: null,
      _session: null,
    });
    return true;
  }

  useWebSocketStore.setState({
    _auth_phase: "idle",
    _auth_error: null,
    _server_verified: false,
    _control: null,
    _session: null,
  });
  await useWebSocketStore.getState().startAuthFlow(true);
  if (useWebSocketStore.getState()._auth_phase === "waiting_password") {
    const password = __WITH_ANDROID__
      ? getAndroidAutoPassword()
      : StorageUtil.get<string>("baasAutoPassword");
    if (!password) return false;
    await useWebSocketStore.getState().submitPassword(password);
  }
  if (useWebSocketStore.getState()._auth_phase !== "authenticated") {
    throw new Error(useWebSocketStore.getState()._auth_error || "Backend authentication failed");
  }
  return true;
};

/** Runs the single coalesced recovery loop shared by WebSocket and Pipe channels. */
const runTransportRecovery = async (epoch: number) => {
  let attempt = 0;
  while (desiredConnectionNames.size > 0 && epoch === transportRecoveryEpoch) {
    const mode = useWebSocketStore.getState().transportMode;
    const runtime = useWebSocketStore.getState().backendRuntime;
    const restartBackend = transportRecoveryMustRestart;
    transportRecoveryMustRestart = false;
    transportRecoveryRestarting = restartBackend;
    closeBusinessConnections(restartBackend);

    try {
      if (restartBackend) {
        useWebSocketStore.setState({
          _auth_phase: "control_connecting",
          _auth_error: null,
          _server_verified: mode === "pipe",
        });
        const startup = await startManagedBackendTransport(mode, runtime);
        if (epoch !== transportRecoveryEpoch) return;
        if (mode === "websocket") applyManagedBackendAddress(startup);
        const authenticated = await restoreTransportAuthentication(mode);
        if (epoch !== transportRecoveryEpoch) return;
        if (!authenticated) return;
      } else if (mode === "websocket" && !useWebSocketStore.getState()._session) {
        transportRecoveryMustRestart = true;
        continue;
      }

      if (transportRecoveryMustRestart) continue;
      await connectDesiredChannels();
      if (epoch !== transportRecoveryEpoch) return;
      if (transportRecoveryMustRestart) continue;

      transportOutageAnnounced = false;
      transportRecoveryRestarting = false;
      void useWebSocketStore.getState().init();
      return;
    } catch (error) {
      transportRecoveryRestarting = false;
      transportRecoveryMustRestart = true;
      appendGlobalLog({
        level: "warning",
        message: `Backend ${mode} recovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      } as any);
      await new Promise((resolve) => setTimeout(resolve, transportRecoveryDelay(attempt)));
      attempt += 1;
    }
  }
};

/** Requests recovery without allowing concurrent channels to start duplicate restarts. */
const requestTransportRecovery = (restartBackend = false): Promise<void> => {
  if (desiredConnectionNames.size === 0) return Promise.resolve();
  if (restartBackend && !transportRecoveryRestarting) {
    transportRecoveryMustRestart = true;
  }
  if (!transportOutageAnnounced) {
    transportOutageAnnounced = true;
    announceServiceTransportDisconnected(useWebSocketStore.getState().transportMode);
  }
  transportRecoveryPromise ??= runTransportRecovery(transportRecoveryEpoch).finally(() => {
    transportRecoveryRestarting = false;
    transportRecoveryPromise = null;
  });
  return transportRecoveryPromise;
};

const connectWithRetry = async (name: WsName, retryInterval = 1000) => {
  const { connect } = useWebSocketStore.getState();

  while (useWebSocketStore.getState()._auth_phase === "authenticated") {
    try {
      await connect(name);
      return;
    } catch (error) {
      console.error(`[${name}] connect failed, starting transport recovery`, error);
      await requestTransportRecovery(true);
      if (useWebSocketStore.getState().connections[name]) return;
      await new Promise((resolve) => setTimeout(resolve, retryInterval));
    }
  }
};

export const waitFor = <T>(
  get: () => any,
  subscribe: any,
  selector: (s: any) => T,
  predicate: (val: T) => boolean,
  timeoutMs = Infinity
) => {
  return new Promise<void>((resolve, reject) => {
    const initial = selector(get());
    if (predicate(initial)) {
      resolve();
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribe(selector, (val: T) => {
      if (predicate(val)) {
        if (timer) clearTimeout(timer);
        unsub();
        resolve();
      }
    });

    if (timeoutMs !== Infinity) {
      timer = setTimeout(() => {
        unsub();
        reject(new Error("waitFor timeout"));
      }, timeoutMs);
    }
  });
};

export const waitForNormal = <T>(
  getter: () => T,
  predicate: (val: T) => boolean,
  timeoutMs = Infinity,
  intervalMs = 50
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let timer: ReturnType<typeof setInterval> | null = null;

    const check = () => {
      try {
        const val = getter();
        if (predicate(val)) {
          if (timer) clearInterval(timer);
          resolve();
        } else if (Date.now() - start >= timeoutMs) {
          if (timer) clearInterval(timer);
          reject(new Error("waitFor timeout"));
        }
      } catch (error) {
        if (timer) clearInterval(timer);
        reject(error);
      }
    };

    timer = setInterval(check, intervalMs);
    check();
  });
};
void waitForNormal;

export const useWebSocketStore = create<WebSocketState>()(
  subscribeWithSelector((set, get, api) => ({
    backendRuntime: "python",
    transportMode: __WITH_TAURI__ ? "pipe" : "websocket",
    setTransportMode: async (mode) =>
      get().setBackendSelection(get().backendRuntime, normalizeTransportMode(mode)),
    setBackendRuntime: async (runtime) =>
      get().setBackendSelection(runtime, runtime === "cpp" ? "websocket" : get().transportMode),
    setBackendSelection: async (runtime, mode) => {
      const previousRuntime = get().backendRuntime;
      const previousMode = get().transportMode;
      const nextRuntime: BackendRuntimeKind = __WITH_ANDROID__ ? "python" : runtime;
      const nextMode = normalizeTransportMode(mode);
      if (nextRuntime === "cpp" && nextMode !== "websocket") {
        throw new Error("C++ backend runtime supports only WebSocket transport");
      }
      transportSwitching = true;
      transportRecoveryEpoch += 1;
      transportRecoveryMustRestart = false;
      transportRecoveryRestarting = false;
      transportOutageAnnounced = false;
      const pendingRecovery = transportRecoveryPromise;
      if (pendingRecovery) await pendingRecovery.catch(() => undefined);
      closeBusinessConnections(true);
      if (__WITH_TAURI__) {
        try {
          const { invoke } = await import("@/shared/TauriInvoke");
          await invoke("backend_pipe_close_all");
        } catch {
          // The pipe manager may not have been started yet.
        }
      }
      set((state) => ({
        ...state,
        ...resetConnectionStores(),
        backendRuntime: nextRuntime,
        transportMode: nextMode,
        _auth_phase: "idle",
        _auth_error: null,
        _server_initialized: false,
        _server_verified: false,
        _control: null,
        _session: null,
      }));
      let selectionActivated = false;
      try {
        const startup = await startManagedBackendTransport(nextMode, nextRuntime);
        selectionActivated = true;
        if (nextMode === "pipe") {
          activeWebSocketBase = null;
          set((state) => ({
            ...state,
            _auth_phase: "authenticated",
            _server_initialized: true,
            _server_verified: true,
          }));
        } else {
          applyManagedBackendAddress(startup);
          transportSwitching = false;
          await get().startAuthFlow(true);
          await waitForNormal(
            () => get()._auth_phase,
            (phase) =>
              phase === "waiting_password" ||
              phase === "authenticated" ||
              phase === "idle" ||
              phase === "revoked",
            15_000
          );
          if (get()._auth_phase === "waiting_password") {
            const password = __WITH_ANDROID__
              ? getAndroidAutoPassword()
              : StorageUtil.get<string>("baasAutoPassword");
            if (!password) {
              throw new Error("The managed backend password is unavailable");
            }
            await get().submitPassword(password);
          }
          if (get()._auth_phase !== "authenticated") {
            throw new Error(get()._auth_error || "Backend authentication failed");
          }
        }
        await connectDesiredChannels();
        void get().init();
      } catch (error) {
        set((state) => ({
          ...state,
          backendRuntime: selectionActivated ? nextRuntime : previousRuntime,
          transportMode: selectionActivated ? nextMode : previousMode,
          _auth_phase: "idle",
          _auth_error: error instanceof Error ? error.message : String(error),
        }));
        throw error;
      } finally {
        transportSwitching = false;
      }
    },
    connections: {},
    logStore: {},
    configStore: {},
    staticStore: {},
    eventStore: {},
    updateStore: {},
    statusStore: {},
    versionStore: {},
    pendingCallbacks: {},
    pendingStreamCallbacks: {},
    pendingBinaryCallbacks: {},
    pendingBinaryQueue: [],

    _all_data_initialized: false,
    _heartbeat_time: 0,
    _initiating: false,
    _auth_phase: "idle",
    _auth_error: null,
    _server_initialized: false,
    _server_verified: false,
    _pwd_epoch: 0,
    _control: null,
    _session: null,

    checkTauriUpdater: async (notify = false, visible = false) => {
      if (!__WITH_TAURI__ || tauriUpdaterChecking) return;
      set((state) => ({
        ...state,
        versionStore: {
          ...state.versionStore,
          tauri: {
            ...(state.versionStore.tauri ?? {}),
            currentVersion: state.versionStore.tauri?.currentVersion ?? __APP_VERSION__,
            version: state.versionStore.tauri?.version ?? __APP_VERSION__,
            checking: true,
            error: null,
          },
        },
      }));
      if (__WITH_ANDROID__) {
        tauriUpdaterChecking = true;
        try {
          const { getVersion } = await import("@tauri-apps/api/app");
          const currentVersion = await getVersion().catch(() => __APP_VERSION__);
          const nextTauriVersion = await checkAndroidClientUpdate(currentVersion);
          set((state) => ({
            ...state,
            versionStore: {
              ...state.versionStore,
              tauri: {
                ...nextTauriVersion,
                currentVersion: nextTauriVersion.currentVersion ?? currentVersion,
              },
            },
          }));
          if (nextTauriVersion.updateAvailable) {
            if (notify && tauriUpdaterNotifiedVersion !== nextTauriVersion.version) {
              toast.info(t("update.tauriAvailable"), {
                description: nextTauriVersion.version,
              });
              tauriUpdaterNotifiedVersion = nextTauriVersion.version;
            }
          } else {
            tauriUpdaterNotifiedVersion = null;
            if (visible) toast.success(t("update.tauriUpToDate"));
          }
        } catch (error) {
          set((state) => ({
            ...state,
            versionStore: {
              ...state.versionStore,
              tauri: {
                ...(state.versionStore.tauri ?? {}),
                checking: false,
                updateAvailable: false,
                lastChecked: Date.now(),
                error: error instanceof Error ? error.message : String(error),
              },
            },
          }));
          if (visible) {
            toast.error(t("update.tauriFailed"), {
              description: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          tauriUpdaterChecking = false;
        }
        return;
      }
      if (await isTauriNoUpdateEnabled()) {
        tauriUpdaterNotifiedVersion = null;
        set((state) => ({
          ...state,
          versionStore: {
            ...state.versionStore,
            tauri: {
              ...(state.versionStore.tauri ?? {}),
              checking: false,
              updateAvailable: false,
              lastChecked: Date.now(),
              error: null,
            },
          },
        }));
        return;
      }
      tauriUpdaterChecking = true;

      try {
        const [{ check }, { getVersion }] = await Promise.all([
          import("@tauri-apps/plugin-updater"),
          import("@tauri-apps/api/app"),
        ]);
        const currentVersion = await getVersion().catch(() => __APP_VERSION__);
        const update = await check();
        const nextTauriVersion = update
          ? {
              updateAvailable: true,
              checking: false,
              currentVersion,
              version: update.version,
              body: update.body ?? "",
              date: update.date ?? "",
              lastChecked: Date.now(),
              error: null,
            }
          : {
              updateAvailable: false,
              checking: false,
              currentVersion,
              version: null,
              body: "",
              date: "",
              lastChecked: Date.now(),
              error: null,
            };

        set((state) => ({
          ...state,
          versionStore: {
            ...state.versionStore,
            tauri: nextTauriVersion,
          },
        }));

        if (update) {
          if (notify && tauriUpdaterNotifiedVersion !== update.version) {
            toast.info(t("update.tauriAvailable"), {
              description: update.version,
            });
            tauriUpdaterNotifiedVersion = update.version;
          }
        } else {
          tauriUpdaterNotifiedVersion = null;
        }
      } catch (error) {
        set((state) => ({
          ...state,
          versionStore: {
            ...state.versionStore,
            tauri: {
              ...(state.versionStore.tauri ?? {}),
              checking: false,
              updateAvailable: false,
              lastChecked: Date.now(),
              error: error instanceof Error ? error.message : String(error),
            },
          },
        }));
      } finally {
        tauriUpdaterChecking = false;
      }
    },

    startTauriUpdaterPolling: () => {
      if (!__WITH_TAURI__ || tauriUpdaterPollTimer) return;
      const check = () => {
        void get().checkTauriUpdater(true, false);
      };
      tauriUpdaterPollTimer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
      if (__WITH_ANDROID__) {
        setTimeout(check, ANDROID_STARTUP_UPDATE_DELAY_MS);
        return;
      }
      check();
    },

    startAuthFlow: async (backendAlreadyStarted = false) => {
      if (transportSwitching) return;
      const authGeneration = transportGeneration;
      const selection = await configuredBackendSelection();
      if (transportSwitching || authGeneration !== transportGeneration) return;
      const transportMode = selection.mode;
      const backendRuntime = selection.runtime;
      if (transportMode === "pipe") {
        if (get()._auth_phase === "authenticated") return;
        set((state) => ({
          ...state,
          ...resetConnectionStores(),
          backendRuntime,
          transportMode,
          _auth_phase: "control_connecting",
          _auth_error: null,
          _server_initialized: true,
          _server_verified: true,
          _control: null,
          _session: null,
        }));
        try {
          await startManagedBackendTransport(transportMode, backendRuntime);
          if (transportSwitching || authGeneration !== transportGeneration) return;
          activeWebSocketBase = null;
          set((state) => ({ ...state, _auth_phase: "authenticated" }));
        } catch (error) {
          if (transportSwitching || authGeneration !== transportGeneration) return;
          set((state) => ({
            ...state,
            _auth_phase: "idle",
            _auth_error: error instanceof Error ? error.message : String(error),
          }));
        }
        return;
      }

      const phase = get()._auth_phase;
      if (
        get()._control ||
        phase === "control_connecting" ||
        phase === "server_verified" ||
        phase === "waiting_password" ||
        phase === "resuming" ||
        phase === "initializing" ||
        phase === "authenticating" ||
        phase === "authenticated"
      ) {
        return;
      }

      set((state) => ({
        ...state,
        backendRuntime,
        transportMode: "websocket",
        _auth_phase: "control_connecting",
        _auth_error: phase === "revoked" ? state._auth_error : null,
        _server_verified: false,
      }));

      try {
        if (backendRuntime === "cpp" && !backendAlreadyStarted) {
          const startup = await startManagedBackendTransport("websocket", backendRuntime);
          if (transportSwitching || authGeneration !== transportGeneration) return;
          applyManagedBackendAddress(startup);
        }
        const control = await ControlConnection.open(`${resolveBase()}/ws/control`);
        if (
          transportSwitching ||
          authGeneration !== transportGeneration ||
          get().transportMode !== "websocket"
        ) {
          control.close();
          return;
        }
        control.onSecureMessage = (payload) => {
          if (payload.type === "heartbeat") {
            set((state) => ({ ...state, _heartbeat_time: payload.timestamp }));
            return;
          }
          if (payload.type === "auth_revoked") {
            const activeControl = get()._control;
            transportGeneration += 1;
            activeControl?.close();
            Object.values(get().connections).forEach((connection) => connection?.close());
            set((state) => ({
              ...state,
              ...resetDataStores(),
              _auth_phase: "revoked",
              _auth_error:
                payload.reason === "password_reset"
                  ? "Password was reset on the server."
                  : "Password changed. Re-enter the current password.",
              _server_initialized: true,
              _server_verified: false,
              _pwd_epoch: Number(payload.pwd_epoch ?? 0),
              _control: null,
              _session: null,
            }));
          }
        };

        const controlGeneration = authGeneration;
        control.onClose = () => {
          if (get()._control !== control) return;
          if (controlGeneration !== transportGeneration) return;
          if (get()._auth_phase === "authenticated") {
            set((state) => ({
              ...state,
              _auth_phase: "idle",
              _auth_error: "Control connection closed. Reconnecting.",
              _server_initialized: true,
              _server_verified: false,
              _control: null,
              _session: null,
            }));
            void requestTransportRecovery(true);
          } else {
            set((state) => ({
              ...state,
              _auth_phase: "idle",
              _control: null,
            }));
          }
        };

        control.onError = (event) => {
          console.error("[control] socket error", event);
        };

        set((state) => ({
          ...state,
          _control: control,
          _server_initialized: control.initialized,
          _server_verified: true,
          _pwd_epoch: control.pwdEpoch,
          _auth_phase: "server_verified",
        }));

        if (control.initialized) {
          set((state) => ({ ...state, _auth_phase: "resuming", _auth_error: null }));
          const session = await control.resumeWithCookie();
          if (
            transportSwitching ||
            authGeneration !== transportGeneration ||
            get().transportMode !== "websocket"
          ) {
            control.close();
            return;
          }
          if (session) {
            set((state) => ({
              ...state,
              ...resetConnectionStores(),
              _auth_phase: "authenticated",
              _auth_error: null,
              _server_initialized: true,
              _server_verified: true,
              _pwd_epoch: session.pwdEpoch,
              _control: control,
              _session: session,
            }));
            return;
          }
        }

        set((state) => ({ ...state, _auth_phase: "waiting_password" }));
      } catch (error) {
        if (transportSwitching || authGeneration !== transportGeneration) return;
        console.error("[control] failed to connect", error);
        set((state) => ({
          ...state,
          _auth_phase: "idle",
          _auth_error: error instanceof Error ? error.message : "Failed to verify server identity.",
          _control: null,
          _server_verified: false,
        }));
      }
    },

    submitPassword: async (password: string) => {
      if (get().transportMode === "pipe") return;
      const secret = password.trim();
      if (!secret) {
        set((state) => ({
          ...state,
          _auth_error: "Password is required.",
        }));
        return;
      }

      let control = get()._control;
      if (!control) {
        await get().startAuthFlow();
        control = get()._control;
      }
      if (!control) {
        throw new Error("Control connection is not ready");
      }

      set((state) => ({
        ...state,
        _auth_phase: control.initialized ? "authenticating" : "initializing",
        _auth_error: null,
      }));

      try {
        const session = await control.authenticate(secret);
        try {
          await rememberControlSession(resolveHttpBase(), session);
        } catch (rememberError) {
          console.warn("[control] failed to persist remembered session", rememberError);
        }
        set((state) => ({
          ...state,
          ...resetConnectionStores(),
          _auth_phase: "authenticated",
          _auth_error: null,
          _server_initialized: true,
          _server_verified: true,
          _pwd_epoch: session.pwdEpoch,
          _control: control,
          _session: session,
        }));
        if (transportOutageAnnounced) void requestTransportRecovery(false);
      } catch (error) {
        console.error("[control] authentication failed", error);
        control.close();
        set((state) => ({
          ...state,
          ...resetDataStores(),
          _auth_phase: "idle",
          _auth_error: error instanceof Error ? error.message : "Authentication failed.",
          _server_verified: false,
          _control: null,
          _session: null,
        }));
      }
    },

    connect: async (name: WsName) => {
      if (!name.startsWith("remote-")) desiredConnectionNames.add(name);
      if (get().connections[name]) return;
      const pendingOpen = connectionOpenPromises.get(name);
      if (pendingOpen) return pendingOpen;

      const opening = (async () => {
        const connectionGeneration = transportGeneration;
      const session = get()._session;
      const transportMode = get().transportMode;
      if (transportMode === "websocket" && !session) {
        throw new Error("No authenticated session is available");
      }
      const channel = (name.startsWith("remote-") ? "remote" : name) as BackendChannelName;
      console.info(`[transport] opening ${transportMode} channel=${channel} name=${name}`);

      const resourceCallBack: WsCallBackDict = {
        config: (message: WsMessageItem) => {
          set((state) => ({
            configStore: {
              ...state.configStore,
              [message.resource_id!]: message.data,
            },
          }));
        },
        event: (message: WsMessageItem) => {
          set((state) => ({
            eventStore: {
              ...state.eventStore,
              [message.resource_id!]: message.data,
            },
          }));
        },
        static: (message: WsMessageItem) => {
          set(() => ({
            staticStore: message.data,
          }));
        },
        setup_toml: (message: WsMessageItem) => {
          set(() => ({
            updateStore: message.data,
          }));
        },
      };

      const callbackDict: WsCallBackDict = {
        "config_list": (message: WsMessageItem) => {
          set((state): Partial<WebSocketState> => {
            const config_added = Object.fromEntries(
              message.data
                .filter((id: string) => !(id in state.configStore))
                .map((id: string) => [id, {}])
            );

            const event_added = Object.fromEntries(
              message.data
                .filter((id: string) => !(id in state.eventStore))
                .map((id: string) => [id, []])
            );

            const log_added: { [key: string]: LogItem[] } = Object.fromEntries(
              message.data
                .map((id: string) => {
                  const key = `config:${id}`;
                  if (key in state.logStore) return null;
                  return [key, []];
                })
                .filter((item: any): item is [string, LogItem[]] => Boolean(item))
            );

            const status_added = Object.fromEntries(
              message.data
                .filter((id: string) => !(id in state.statusStore))
                .map((id: string) => [id, {}])
            );

            const config_kept = Object.fromEntries(
              Object.entries(state.configStore).filter(([id]) => message.data.includes(id))
            );
            const event_kept = Object.fromEntries(
              Object.entries(state.eventStore).filter(([id]) => message.data.includes(id))
            );
            const log_kept = Object.fromEntries(
              Object.entries(state.logStore).filter(([key]) => {
                // Keep provider-owned scopes such as global logs while pruning removed config scopes.
                if (!key.startsWith("config:")) return true;
                return message.data.some((id: string) => key === `config:${id}`);
              })
            );
            const status_kept = Object.fromEntries(
              Object.entries(state.statusStore).filter(([id]) => message.data.includes(id))
            );

            return {
              configStore: { ...config_kept, ...config_added },
              eventStore: { ...event_kept, ...event_added },
              logStore: { ...log_kept, ...log_added },
              statusStore: { ...status_kept, ...status_added },
            };
          });
        },

        "snapshot": (message: WsMessageItem) => {
          resourceCallBack[message.resource!]?.(message);
        },

        "logs_full": (message: WsMessageItem) => {
          const scopes = message.scopes ?? [];
          const logSnapshot: { [key: string]: LogItem[] } = Object.fromEntries(
            scopes.map((id) => [id, []])
          );
          message.entries?.forEach((entry: RawLogItem) => {
            const info = {
              time: entry.time,
              level: entry.level,
              message: entry.message,
            };
            if (!logSnapshot[entry.scope]) logSnapshot[entry.scope] = [];
            logSnapshot[entry.scope].push(info);
            if (entry.scope === "global") appendGlobalLog(info);
          });
          set((state) => ({
            logStore: {
              ...state.logStore,
              ...logSnapshot,
            },
          }));
        },

        "log": (message: WsMessageItem) => {
          const entry = message.entry!;
          const info = {
            time: entry.time,
            level: entry.level,
            message: entry.message,
          };
          set((state) => {
            const prevLogs = state.logStore[entry.scope] ?? [];
            return {
              logStore: {
                ...state.logStore,
                [entry.scope]: [...prevLogs, info],
              },
            };
          });
          if (entry.scope === "global") appendGlobalLog(info);
        },

        "status": (message: WsMessageItem) => {
          const data = message.status;
          if (typeof data === "string" || !data) return;
          if ("is_all_data_initialized" in data) {
            set({ _all_data_initialized: true });
          } else if ("version" in data) {
            const version = (data as any).version;
            set((state) => ({
              versionStore: {
                ...state.versionStore,
                local: version.local,
                remote: version.remote,
                updateAvailable: version.update_available,
                channel: version.channel,
                method: version.method,
              },
            }));
          } else {
            const firstKey = Object.keys(data)[0];
            if (typeof data[firstKey] === "object" && "config_id" in data[firstKey]) {
              set((state) => {
                const statusStore = { ...state.statusStore };
                Object.keys(data).forEach((key) => {
                  statusStore[key] = {
                    ...(statusStore[key] ?? {}),
                    ...(data[key] as StatusItem),
                  };
                });
                return { statusStore };
              });
            } else {
              set((state) => ({
                statusStore: {
                  ...state.statusStore,
                  [(data as StatusItem).config_id!]: (data as WrappedStatusItem).status,
                },
              }));
            }
          }
        },

        "command_response": (message: WsMessageItem) => {
          const { timestamp, command, data, status, error } = message;
          const streamCallback = get().pendingStreamCallbacks[timestamp!];
          if (streamCallback) {
            streamCallback({ command, data, status, error });
            if (data?.done || status === "error") {
              delete get().pendingStreamCallbacks[timestamp!];
            }
            return;
          }
          const callback = get().pendingCallbacks[timestamp!];
          if (callback) {
            if (data?.binary) {
              get().pendingBinaryCallbacks[timestamp!] = (binary: ArrayBuffer) => {
                callback({ command, data, status, binary });
                delete get().pendingCallbacks[timestamp!];
              };
              get().pendingBinaryQueue.push(timestamp!);
              return;
            }
            callback({ command, data, status });
            delete get().pendingCallbacks[timestamp!];
          } else {
            console.warn("CallBack Not Found:", message);
          }
        },

        "patch": (message: WsMessageItem) => {
          const ops = message.ops;
          const resource = message.resource;
          if (resource === "gui") return;
          const resourceId = message.resource_id ?? null;
          if (!resourceId || !Array.isArray(ops)) return;

          ops.forEach((op) => {
            if (op.op === "add") {
              get().send("sync", { type: "list" });
              const prevLength = Object.keys(get().configStore).length;
              waitFor(
                get,
                api.subscribe,
                (state: WebSocketState) => Object.keys(state.configStore).length,
                (length) => length === prevLength + 1
              ).then(() => {
                get().send("sync", { type: "pull", resource: "config", resource_id: resourceId });
                get().send("sync", { type: "pull", resource: "event", resource_id: resourceId });
              });
            }
            if (op.op === "remove") {
              get().send("sync", { type: "list" });
            } else {
              const path = `${resourceId}::${resource}${op.path}`;
              get().patch(path, op.value);
            }
          });
        },

        "patch_ack": (message: WsMessageItem) => {
          pendingSyncPatches.delete(message.timestamp!);
          const callback = get().pendingCallbacks[message.timestamp!];
          if (callback) {
            callback();
            delete get().pendingCallbacks[message.timestamp!];
          } else {
            console.warn("CallBack Not Found:", message);
          }
        },

        "patch_conflict": (message: WsMessageItem) => {
          resourceCallBack[message.resource!]?.(message);

          const requestTimestamp = Number(message.request_timestamp);
          const pending = pendingSyncPatches.get(requestTimestamp);
          const callback = get().pendingCallbacks[requestTimestamp];
          pendingSyncPatches.delete(requestTimestamp);
          delete get().pendingCallbacks[requestTimestamp];
          if (!pending) return;

          if (pending.retries >= MAX_SYNC_PATCH_RETRIES) {
            appendGlobalLog({
              level: "error",
              message: `Sync patch retry limit reached for ${pending.resource}:${pending.resourceId}`,
            } as any);
            return;
          }

          const retryTimestamp = allocateCorrelationId(
            get(),
            Math.ceil(Number(message.timestamp) || 0)
          );

          pendingSyncPatches.set(retryTimestamp, {
            ...pending,
            retries: pending.retries + 1,
          });
          if (callback) get().pendingCallbacks[retryTimestamp] = callback;
          get().send("sync", {
            type: "patch",
            resource_id: pending.resourceId,
            resource: pending.resource,
            timestamp: retryTimestamp,
            ops: pending.ops,
          });
        },
      };

      const ws = await openBackendChannel({
        mode: transportMode,
        channel,
        name,
        baseUrl: resolveBase(),
        session,
      });
      let connectionErrored = false;
      ws.onClose = () => {
        set((state) => {
          if (state.connections[name] !== ws) return state;
          const next = { ...state.connections };
          delete next[name];
          return { connections: next };
        });
        if (
          connectionGeneration === transportGeneration &&
          desiredConnectionNames.has(name)
        ) {
          void requestTransportRecovery(connectionErrored);
        }
      };
      ws.onError = (event) => {
        connectionErrored = true;
        console.error("Socket error:", event);
      };
      await ws.connect((message: any) => {
        if (message instanceof ArrayBuffer) {
          const timestamp = get().pendingBinaryQueue.shift();
          if (timestamp !== undefined) {
            const callback = get().pendingBinaryCallbacks[timestamp];
            if (callback) {
              callback(message);
              delete get().pendingBinaryCallbacks[timestamp];
            }
          }
          return;
        }
        callbackDict[message.type]?.(message as WsMessageItem);
      });
      if (connectionGeneration !== transportGeneration) {
        await ws.close();
        return;
      }
      console.info(`[transport] opened ${transportMode} channel=${channel} name=${name}`);

        set((state) => ({
          connections: {
            ...state.connections,
            [name]: ws,
          },
        }));
      })();
      connectionOpenPromises.set(name, opening);
      try {
        await opening;
      } finally {
        if (connectionOpenPromises.get(name) === opening) {
          connectionOpenPromises.delete(name);
        }
      }
    },

    connectRemote: async (): Promise<BackendConnection> => {
      if (__WITH_ANDROID__) {
        throw new Error("Remote control is disabled on Android.");
      }
      const session = get()._session;
      const transportMode = get().transportMode;
      if (transportMode === "websocket" && !session) {
        throw new Error("No authenticated session is available");
      }
      const unique = randomUUID();
      const name = `remote-${unique}` as `remote-${string}`;
      const ws = await openBackendChannel({
        mode: transportMode,
        channel: "remote",
        name,
        baseUrl: resolveBase(),
        session,
      });

      ws.hookClose = () => {
        set((state) => {
          const next = { ...state.connections };
          delete next[name];
          return { connections: next };
        });
      };

      set((state) => ({
        connections: {
          ...state.connections,
          [name]: ws,
        },
      }));

      return ws;
    },

    disconnect: (name: WsName) => {
      desiredConnectionNames.delete(name);
      const conn = get().connections[name];
      if (conn) {
        conn.close();
        set((state) => {
          const next = { ...state.connections };
          delete next[name];
          return { connections: next };
        });
      }
    },

    recoverTransport: () => requestTransportRecovery(true),

    send: (name: WsName, data: any) => {
      const conn = get().connections[name];
      conn?.sendJson(data);
    },

    init: async () => {
      if (get()._initiating || get()._all_data_initialized) return;
      if (get()._auth_phase !== "authenticated") return;

      set((state) => ({ ...state, _initiating: true }));
      console.info(`[transport] initializing data over ${get().transportMode}`);

      await StorageUtil.init();

      try {
        await connectWithRetry("provider");
        await connectWithRetry("sync");

        get().send("sync", { type: "pull", resource: "static" });
        await waitFor(
          get,
          api.subscribe,
          (state: WebSocketState) => Object.keys(state.staticStore).length,
          (length) => length > 0
        );

        get().send("sync", { type: "pull", resource: "setup_toml", resource_id: "global" });
        await waitFor(
          get,
          api.subscribe,
          (state: WebSocketState) => Object.keys(state.updateStore).length,
          (length) => length > 0
        );

        get().send("sync", { type: "list" });
        await waitFor(
          get,
          api.subscribe,
          (state: WebSocketState) => Object.keys(state.configStore).length,
          (length) => length > 0
        );

        Object.keys(get().configStore).forEach((key: string) => {
          get().send("sync", { type: "pull", resource: "config", resource_id: key });
        });

        Object.keys(get().configStore).forEach((key: string) => {
          get().send("sync", { type: "pull", resource: "event", resource_id: key });
        });

        await waitFor(
          get,
          api.subscribe,
          (state: WebSocketState) => Object.keys(state.eventStore).length,
          (length) => length > 0
        );

        await connectWithRetry("trigger");

        const skipBackendUpdater = await isTauriNoUpdateEnabled();
        if (skipBackendUpdater && __WITH_ANDROID__) {
          set((state) => ({
            ...state,
            versionStore: {
              ...state.versionStore,
              local: "android-bundled",
              remote: "android-bundled",
              updateAvailable: false,
              channel: "dev",
              method: "disabled",
              lastChecked: Date.now(),
            },
          }));
        } else if (__WITH_ANDROID__) {
          set((state) => ({
            ...state,
            versionStore: {
              ...state.versionStore,
              updateAvailable: false,
              channel: state.updateStore?.channel ?? "dev",
              method: "deferred",
              checking: true,
            },
          }));
          startBackendUpdaterPolling(ANDROID_STARTUP_UPDATE_DELAY_MS);
        } else if (skipBackendUpdater) {
          let local: string | null = null;
          try {
            const { invoke } = await import("@/shared/TauriInvoke");
            const startup = await invoke<any>("updater_get_startup_state");
            const general = startup?.config?.general ?? {};
            local =
              general.current_baas_sha ??
              general.currentBaasSha ??
              general.current_baas_version ??
              null;
          } catch (error) {
            appendGlobalLog({
              level: "warning",
              message: `Failed to read the local backend version: ${
                error instanceof Error ? error.message : String(error)
              }`,
            } as any);
          }
          set((state) => ({
            ...state,
            versionStore: {
              ...state.versionStore,
              local,
              remote: null,
              updateAvailable: false,
              channel: state.updateStore?.channel ?? "stable",
              method: "disabled",
              checking: false,
              lastChecked: Date.now(),
            },
          }));
        } else {
          startBackendUpdaterPolling();

          await waitFor(
            get,
            api.subscribe,
            (state: WebSocketState) => state.versionStore,
            (versionStore) => Object.keys(versionStore).length > 0
          );
        }

        await waitFor(
          get,
          api.subscribe,
          (state: WebSocketState) => state._all_data_initialized,
          (status) => status
        );
      } finally {
        set({ _initiating: false });
      }
    },

    patch: (path: string, patch: any) => {
      const [resourceId, scopeRaw] = path.split("::");
      const [scope, ...keys] = scopeRaw.split("/");

      set((state: WebSocketState) => {
        let storeKey: keyof WebSocketState;
        switch (scope) {
          case "config":
            storeKey = "configStore";
            break;
          case "event":
            storeKey = "eventStore";
            break;
          case "setup_toml":
            storeKey = "updateStore";
            break;
          default:
            throw new Error(`Unknown resource scope: ${scope}`);
        }

        const store = state[storeKey] as Record<string, any>;
        const prev = store?.[resourceId] ?? {};

        if (!(keys[0] in prev) && patch === undefined) {
          return state;
        }

        let base = { ...prev };
        if (keys.length === 0 || (keys.length === 1 && keys[0] === "")) {
          base = patch;
        } else {
          let current = base;
          for (let index = 0; index < keys.length - 1; index += 1) {
            const key = keys[index];
            if (!current[key]) {
              current[key] = {};
            }
            current = current[key];
          }
          current[keys[keys.length - 1]] = patch;
        }

        if (resourceId === "global") {
          return {
            [storeKey]: {
              ...store,
              ...base,
            },
          };
        }

        return {
          [storeKey]: {
            ...store,
            [resourceId]: base,
          },
        };
      });
    },

    modify: (path: string, patch: any, showToast = false) => {
      const [resourceId, scope] = path.split("::");
      const timestamp = allocateCorrelationId(get());
      const ops = isPlainObject(patch)
        ? Object.entries(patch).map(([key, value]) => ({
            op: "replace",
            path: `/${key}`,
            value,
          }))
        : [
            {
              op: "replace",
              path: "/",
              value: patch,
            },
          ];

      get().pendingCallbacks[timestamp] = () => {
        if (showToast) {
          toast.success(t("settings.updateSuccess"), {
            description: t("description.settings.updateSuccess"),
          });
        }
      };
      pendingSyncPatches.set(timestamp, {
        resource: scope,
        resourceId,
        ops,
        retries: 0,
      });

      get().send("sync", {
        type: "patch",
        resource_id: resourceId,
        resource: scope,
        timestamp,
        ops,
      });
    },

    trigger: (payload, callback) => {
      const timestamp = allocateCorrelationId(get());
      if (callback) {
        get().pendingCallbacks[timestamp] = callback;
      }
      const normalizedPayload = {
        ...payload,
        timestamp,
      };
      get().send("trigger", {
        type: "command",
        ...normalizedPayload,
      });
    },

    triggerStream: (payload, callback) => {
      const timestamp = allocateCorrelationId(get());
      if (callback) {
        get().pendingStreamCallbacks[timestamp] = callback;
      }
      const normalizedPayload = {
        ...payload,
        timestamp,
      };
      get().send("trigger", {
        type: "command",
        ...normalizedPayload,
      });
    },

    triggerBinary: (payload, binary, callback) => {
      const timestamp = allocateCorrelationId(get());
      if (callback) {
        get().pendingCallbacks[timestamp] = callback;
      }
      const normalizedPayload = {
        ...payload,
        timestamp,
        payload: {
          ...payload.payload,
          binary: true,
        },
      };
      const conn = get().connections.trigger;
      conn?.sendJson({
        type: "command",
        ...normalizedPayload,
      });
      conn?.sendBytes(binary);
    },
  }))
);
