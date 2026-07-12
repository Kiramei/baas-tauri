import { toast } from "sonner";
import { create } from "zustand";
import {
  getPreferredBackendTransportMode,
  normalizeBackendTransportMode,
  openBackendChannel,
  setPreferredBackendTransportMode,
  startBackendTransport,
} from "@/transport/factory";
import type { BackendChannelName } from "@/transport/types";
import type { BackendConnection } from "@/transport/types";
import { subscribeWithSelector } from "zustand/middleware";
import { getTimestampMs, isPlainObject } from "@/shared/GlobalUtilities.ts";
import { useGlobalLogStore } from "@/store/GlobalLogStore";
import { t } from "i18next";
import { rejectPendingTransportCallbacks } from "@/store/transportCallbackCleanup";
import {
  BackendCallbackDict,
  BackendChannelKey,
  BackendMessageItem,
  BackendState,
  LogItem,
  RawLogItem,
  StatusItem,
  WrappedStatusItem,
} from "@/types/app";
import StorageUtil from "@/shared/StorageManager.ts";

/** Returns the resolve base result. */
let activeWebSocketBase: string | null = null;

/** Returns the resolve base result. */
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

/** Returns the resolve http base result. */
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

/** Returns a random UUID without importing WebSocket/auth code in Tauri builds. */
const randomUUID = (): string => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    const normalized = char === "x" ? value : (value & 0x3) | 0x8;
    return normalized.toString(16);
  });
};

/** Returns the is tauri no update enabled result. */
export const isTauriNoUpdateEnabled = async (): Promise<boolean> => {
  if (!__WITH_TAURI__) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const startup = await invoke<any>("updater_get_startup_state");
    const general = startup?.config?.general ?? {};
    return Boolean(general.no_update ?? general.noUpdate ?? false);
  } catch {
    return false;
  }
};

/** Handles the check backend updater workflow. */
const checkBackendUpdater = async () => {
  if (__WITH_TAURI__) {
    if (backendUpdaterChecking) return;
    backendUpdaterChecking = true;
    const resetTimer = setTimeout(() => {
      backendUpdaterChecking = false;
    }, 30_000);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
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

/** Performs the start backend updater polling operation. */
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

/** Handles the check android client update workflow. */
const checkAndroidClientUpdate = async (currentVersion?: string) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<any>("tauri_client_check_update", {
    request: {
      currentVersion,
    },
  });
};

/** Performs the reset connection stores operation. */
const resetConnectionStores = (): Partial<BackendState> => ({
  connections: {},
  pendingCallbacks: {},
  pendingStreamCallbacks: {},
  pendingBinaryCallbacks: {},
  pendingBinaryQueue: [],
  _all_data_initialized: false,
  _heartbeat_time: 0,
  _initiating: false,
});

/** Performs the reset data stores operation. */
const resetDataStores = (): Partial<BackendState> => ({
  ...resetConnectionStores(),
  logStore: {},
  configStore: {},
  staticStore: {},
  eventStore: {},
  updateStore: {},
  statusStore: {},
  versionStore: {},
});

/** Performs the connect with retry operation. */
const connectWithRetry = async (name: BackendChannelKey, retryInterval = 1000) => {
  const { connect } = useWebSocketStore.getState();

  while (useWebSocketStore.getState()._auth_phase === "authenticated") {
    try {
      await connect(name);
      return;
    } catch (error) {
      console.error(`[${name}] connect failed, retrying in ${retryInterval}ms`, error);
      await new Promise((resolve) => setTimeout(resolve, retryInterval));
    }
  }
};

/** Handles the wait for workflow. */
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

/** Handles the wait for normal workflow. */
export const waitForNormal = <T>(
  getter: () => T,
  predicate: (val: T) => boolean,
  timeoutMs = Infinity,
  intervalMs = 50
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let timer: ReturnType<typeof setInterval> | null = null;

    /** Handles the check workflow. */
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

const transportRequiresAuthentication = (mode: BackendState["transportMode"]) => mode === "websocket";
const isSharedMemoryTransport = (mode: BackendState["transportMode"]) => mode === "shared-memory";
const initialTransportMode = normalizeBackendTransportMode();

export const useWebSocketStore = create<BackendState>()(
  subscribeWithSelector((set, get, api) => ({
    transportMode: initialTransportMode,
    connectionPhase: "idle",
    requiresAuthentication: transportRequiresAuthentication(initialTransportMode),
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

    setTransportMode: async (mode) => {
      const previousMode = get().transportMode;
      const nextMode = setPreferredBackendTransportMode(mode);
      if (previousMode === nextMode && get()._auth_phase === "authenticated") return;
      if (nextMode === "shared-memory") activeWebSocketBase = null;

      Object.values(get().connections).forEach((connection) => {
        void connection?.close();
      });
      get()._control?.close();
      if (previousMode === "shared-memory" && __WITH_TAURI__) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("backend_ipc_close");
        } catch (error) {
          console.warn("failed to close shared-memory backend", error);
        }
      }

      set((state) => ({
        ...state,
        ...resetDataStores(),
        transportMode: nextMode,
        connectionPhase: "idle",
        requiresAuthentication: transportRequiresAuthentication(nextMode),
        _auth_phase: "idle",
        _auth_error: null,
        _server_initialized: false,
        _server_verified: false,
        _control: null,
        _session: null,
      }));
      await get().startAuthFlow();
    },

    checkTauriUpdater: async (notify = false, visible = false) => {
      if (!__WITH_TAURI__ || tauriUpdaterChecking) return;
      if (__WITH_ANDROID__) {
        tauriUpdaterChecking = true;
        if (visible) {
          set((state) => ({
            ...state,
            versionStore: {
              ...state.versionStore,
              tauri: {
                ...(state.versionStore.tauri ?? {}),
                checking: true,
                error: null,
              },
            },
          }));
        }
        try {
          const { getVersion } = await import("@tauri-apps/api/app");
          const currentVersion = await getVersion().catch(() => undefined);
          const nextTauriVersion = await checkAndroidClientUpdate(currentVersion);
          set((state) => ({
            ...state,
            versionStore: {
              ...state.versionStore,
              tauri: nextTauriVersion,
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
      if (visible) {
        set((state) => ({
          ...state,
          versionStore: {
            ...state.versionStore,
            tauri: {
              ...(state.versionStore.tauri ?? {}),
              checking: true,
              error: null,
            },
          },
        }));
      }

      try {
        const [{ check }, { getVersion }] = await Promise.all([
          import("@tauri-apps/plugin-updater"),
          import("@tauri-apps/api/app"),
        ]);
        const currentVersion = await getVersion().catch(() => undefined);
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
      setTimeout(check, 30_000);
    },

    startAuthFlow: async () => {
      const transportMode = get().transportMode;
      if (isSharedMemoryTransport(transportMode)) {
        if (get()._auth_phase === "authenticated" || get().connectionPhase === "connecting") return;
        set((state) => ({
          ...state,
          ...resetConnectionStores(),
          transportMode,
          connectionPhase: "starting-backend",
          requiresAuthentication: false,
          _auth_phase: "idle",
          _auth_error: null,
          _server_initialized: true,
          _server_verified: true,
          _control: null,
          _session: null,
        }));
        try {
          await startBackendTransport(transportMode);
          set((state) => ({
            ...state,
            connectionPhase: "ready",
            _auth_phase: "authenticated",
          }));
        } catch (error) {
          set((state) => ({
            ...state,
            connectionPhase: "failed",
            _auth_phase: "idle",
            _auth_error: error instanceof Error ? error.message : String(error),
          }));
        }
        return;
      }
      if (__WITH_TAURI__) {
        set((state) => ({
          ...state,
          ...resetConnectionStores(),
          transportMode: "websocket",
          connectionPhase: "starting-backend",
          requiresAuthentication: true,
          _auth_error: null,
        }));
        try {
          const startup = await startBackendTransport("websocket");
          if (startup.baseBackendAddr && startup.baseBackendPort) {
            activeWebSocketBase = `ws://${startup.baseBackendAddr}:${startup.baseBackendPort}`;
          }
        } catch (error) {
          set((state) => ({
            ...state,
            connectionPhase: "failed",
            _auth_phase: "idle",
            _auth_error: error instanceof Error ? error.message : String(error),
          }));
          return;
        }
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
        connectionPhase: "connecting",
        transportMode: "websocket",
        requiresAuthentication: true,
        _auth_phase: "control_connecting",
        _auth_error: phase === "revoked" ? state._auth_error : null,
        _server_verified: false,
      }));

      try {
        const { ControlConnection } = await import("@/shared/SecureWebSocket");
        const control = await ControlConnection.open(`${resolveBase()}/ws/control`);
        control.onSecureMessage = (payload) => {
          if (payload.type === "heartbeat") {
            set((state) => ({ ...state, _heartbeat_time: payload.timestamp }));
            return;
          }
          if (payload.type === "auth_revoked") {
            const activeControl = get()._control;
            activeControl?.close();
            Object.values(get().connections).forEach((connection) => connection?.close());
            set((state) => ({
              ...state,
              ...resetDataStores(),
              connectionPhase: "failed",
              ...rejectPendingTransportCallbacks(state, "Control connection closed"),
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

        control.onClose = () => {
          if (get()._control !== control) return;
          if (get()._auth_phase === "authenticated") {
            Object.values(get().connections).forEach((connection) => connection?.close());
            set((state) => ({
              ...state,
              ...resetConnectionStores(),
              connectionPhase: "failed",
              ...rejectPendingTransportCallbacks(state, "Control connection closed"),
              _auth_phase: "revoked",
              _auth_error: "Control connection closed. Authenticate again.",
              _server_initialized: true,
              _server_verified: false,
              _control: null,
              _session: null,
            }));
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
          if (session) {
            set((state) => ({
              ...state,
              ...resetConnectionStores(),
              connectionPhase: "ready",
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
        console.error("[control] failed to connect", error);
        set((state) => ({
          ...state,
          connectionPhase: "failed",
          _auth_phase: "idle",
          _auth_error: error instanceof Error ? error.message : "Failed to verify server identity.",
          _control: null,
          _server_verified: false,
        }));
      }
    },

    submitPassword: async (password: string) => {
      if (isSharedMemoryTransport(get().transportMode)) {
        set((state) => ({
          ...state,
          _auth_error: "Shared-memory transport does not use WebUI password authentication.",
        }));
        return;
      }
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
          const { rememberControlSession } = await import("@/shared/SecureWebSocket");
          await rememberControlSession(resolveHttpBase(), session);
        } catch (rememberError) {
          console.warn("[control] failed to persist remembered session", rememberError);
        }
        set((state) => ({
          ...state,
          ...resetConnectionStores(),
          connectionPhase: "ready",
          _auth_phase: "authenticated",
          _auth_error: null,
          _server_initialized: true,
          _server_verified: true,
          _pwd_epoch: session.pwdEpoch,
          _control: control,
          _session: session,
        }));
      } catch (error) {
        console.error("[control] authentication failed", error);
        control.close();
        set((state) => ({
          ...state,
          ...resetDataStores(),
          connectionPhase: "failed",
          _auth_phase: "idle",
          _auth_error: error instanceof Error ? error.message : "Authentication failed.",
          _server_verified: false,
          _control: null,
          _session: null,
        }));
      }
    },

    connect: async (name: BackendChannelKey) => {
      if (get().connections[name]) return;
      const session = get()._session;
      const transportMode = get().transportMode;
      if (transportRequiresAuthentication(transportMode) && !session) {
        throw new Error("No authenticated session is available");
      }

      const channel = (name.startsWith("remote-") ? "remote" : name) as BackendChannelName;

      const resourceCallBack: BackendCallbackDict = {
        config: (message: BackendMessageItem) => {
          set((state) => ({
            configStore: {
              ...state.configStore,
              [message.resource_id!]: message.data,
            },
          }));
        },
        event: (message: BackendMessageItem) => {
          set((state) => ({
            eventStore: {
              ...state.eventStore,
              [message.resource_id!]: message.data,
            },
          }));
        },
        static: (message: BackendMessageItem) => {
          set(() => ({
            staticStore: message.data,
          }));
        },
        setup_toml: (message: BackendMessageItem) => {
          set(() => ({
            updateStore: message.data,
          }));
        },
      };

      const callbackDict: BackendCallbackDict = {
        "config_list": (message: BackendMessageItem) => {
          set((state): Partial<BackendState> => {
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

        "snapshot": (message: BackendMessageItem) => {
          resourceCallBack[message.resource!]?.(message);
        },

        "logs_full": (message: BackendMessageItem) => {
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

        "log": (message: BackendMessageItem) => {
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

        "status": (message: BackendMessageItem) => {
          const data = message.status;
          if (typeof data === "string" || !data) return;
          if ("is_all_data_initialized" in data) {
            set((state) => ({ ...state, _all_data_initialized: true }));
          } else if ("version" in data) {
            const version = (data as any).version;
            set((state) => ({
              ...state,
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
              Object.keys(data).forEach((key) => {
                set((state) => ({
                  statusStore: {
                    ...state.statusStore,
                    [key]: {
                      ...(state.statusStore[key] ?? {}),
                      ...(data[key] as StatusItem),
                    },
                  },
                }));
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

        "command_response": (message: BackendMessageItem) => {
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
                callback({ command, data, status, error, binary });
                delete get().pendingCallbacks[timestamp!];
              };
              get().pendingBinaryQueue.push(timestamp!);
              return;
            }
            callback({ command, data, status, error });
            delete get().pendingCallbacks[timestamp!];
          } else {
            console.warn("CallBack Not Found:", message);
          }
        },

        "patch": (message: BackendMessageItem) => {
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
                (state: BackendState) => Object.keys(state.configStore).length,
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

        "patch_ack": (message: BackendMessageItem) => {
          const callback = get().pendingCallbacks[message.timestamp!];
          if (callback) {
            callback();
            delete get().pendingCallbacks[message.timestamp!];
          } else {
            console.warn("CallBack Not Found:", message);
          }
        },
      };

      const ws = await openBackendChannel(
        channel,
        isSharedMemoryTransport(transportMode)
          ? { name, binaryType: "arraybuffer" }
          : {
              baseUrl: resolveBase(),
              session,
              transportMode,
              name,
              binaryType: "arraybuffer",
            }
      );
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
        callbackDict[message.type]?.(message as BackendMessageItem);
      });

      ws.onClose = () => {
        set((state) => {
          const next = { ...state.connections };
          delete next[name];
          return {
            connections: next,
            ...(name === "sync" || name === "trigger"
              ? rejectPendingTransportCallbacks(state, `${name} transport closed`)
              : {}),
          };
        });
      };

      ws.onError = (event) => {
        console.error("Socket error:", event);
        if (name === "sync" || name === "trigger") {
          set((state) => rejectPendingTransportCallbacks(state, `${name} transport error`));
        }
      };

      set((state) => ({
        connections: {
          ...state.connections,
          [name]: ws,
        },
      }));
    },

    connectRemote: async (): Promise<BackendConnection> => {
      if (__WITH_ANDROID__) {
        throw new Error("Remote control is disabled on Android.");
      }
      const session = get()._session;
      const transportMode = get().transportMode;
      if (transportRequiresAuthentication(transportMode) && !session) {
        throw new Error("No authenticated session is available");
      }
      const unique = randomUUID();
      const name = `remote-${unique}` as `remote-${string}`;
      const ws = await openBackendChannel(
        "remote",
        isSharedMemoryTransport(transportMode)
          ? { name, binaryType: "arraybuffer" }
          : {
              baseUrl: resolveBase(),
              session,
              transportMode,
              name,
              binaryType: "arraybuffer",
            }
      );

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

    disconnect: (name: BackendChannelKey) => {
      const conn = get().connections[name];
      if (conn) {
        conn.close();
        set((state) => {
          const next = { ...state.connections };
          delete next[name];
          return {
            connections: next,
            ...(name === "sync" || name === "trigger"
              ? rejectPendingTransportCallbacks(state, `${name} transport disconnected`)
              : {}),
          };
        });
      }
    },

    send: (name: BackendChannelKey, data: any) => {
      const conn = get().connections[name];
      conn?.sendJson(data);
    },

    init: async () => {
      if (get()._initiating || get()._all_data_initialized) return;
      if (get()._auth_phase !== "authenticated") return;

      set((state) => ({ ...state, _initiating: true }));

      await StorageUtil.init();

      try {
        await connectWithRetry("provider");
        await connectWithRetry("sync");

        get().send("sync", { type: "pull", resource: "static" });
        await waitFor(
          get,
          api.subscribe,
          (state: BackendState) => Object.keys(state.staticStore).length,
          (length) => length > 0
        );

        get().send("sync", { type: "pull", resource: "setup_toml", resource_id: "global" });
        await waitFor(
          get,
          api.subscribe,
          (state: BackendState) => Object.keys(state.updateStore).length,
          (length) => length > 0
        );

        get().send("sync", { type: "list" });
        await waitFor(
          get,
          api.subscribe,
          (state: BackendState) => Object.keys(state.configStore).length,
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
          (state: BackendState) => Object.keys(state.eventStore).length,
          (length) => length > 0
        );

        await connectWithRetry("trigger");

        const skipBackendUpdater = await isTauriNoUpdateEnabled();
        if (skipBackendUpdater) {
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
        } else {
          set((state) => ({
            ...state,
            versionStore: {
              ...state.versionStore,
              channel: state.updateStore?.channel ?? "dev",
              method: "deferred",
              checking: true,
            },
          }));
          startBackendUpdaterPolling(5_000);
        }

        await waitFor(
          get,
          api.subscribe,
          (state: BackendState) => state._all_data_initialized,
          (status) => status
        );
      } finally {
        set((state) => ({ ...state, _initiating: false }));
      }
    },

    patch: (path: string, patch: any) => {
      const [resourceId, scopeRaw] = path.split("::");
      const [scope, ...keys] = scopeRaw.split("/");

      set((state: BackendState) => {
        let storeKey: keyof BackendState;
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
            ...state,
            [storeKey]: {
              ...store,
              ...base,
            },
          };
        }

        return {
          ...state,
          [storeKey]: {
            ...store,
            [resourceId]: base,
          },
        };
      });
    },

    modify: (path: string, patch: any, showToast = false) => {
      const [resourceId, scope] = path.split("::");
      const timestamp = getTimestampMs();
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

      get().send("sync", {
        type: "patch",
        resource_id: resourceId,
        resource: scope,
        timestamp,
        ops,
      });
    },

    trigger: (payload, callback) => {
      const timestamp = payload.timestamp || Date.now();
      if (callback) {
        get().pendingCallbacks[timestamp] = callback;
      }
      const normalizedPayload = {
        ...payload,
        timestamp,
      };
      const conn = get().connections.trigger;
      const message = {
        type: "command",
        ...normalizedPayload,
      };
      if (!conn || conn.readyState !== 1) {
        delete get().pendingCallbacks[timestamp];
        callback?.({
          command: payload.command,
          status: "error",
          error: "trigger transport is not connected",
        });
        return;
      }
      const result = conn.sendJson(message);
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          delete get().pendingCallbacks[timestamp];
          callback?.({
            command: payload.command,
            status: "error",
            error: String(error),
          });
        });
      }
    },

    triggerStream: (payload, callback) => {
      const timestamp = payload.timestamp || Date.now();
      if (callback) {
        get().pendingStreamCallbacks[timestamp] = callback;
      }
      const normalizedPayload = {
        ...payload,
        timestamp,
      };
      const conn = get().connections.trigger;
      if (!conn || conn.readyState !== 1) {
        delete get().pendingStreamCallbacks[timestamp];
        callback?.({
          command: payload.command,
          status: "error",
          error: "trigger transport is not connected",
        });
        return;
      }
      const result = conn.sendJson({
        type: "command",
        ...normalizedPayload,
      });
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          delete get().pendingStreamCallbacks[timestamp];
          callback?.({
            command: payload.command,
            status: "error",
            error: String(error),
          });
        });
      }
    },

    triggerBinary: (payload, binary, callback) => {
      const timestamp = payload.timestamp || Date.now();
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
      if (!conn || conn.readyState !== 1) {
        delete get().pendingCallbacks[timestamp];
        callback?.({
          command: payload.command,
          status: "error",
          error: "trigger transport is not connected",
        });
        return;
      }
      const sendJson = conn.sendJson({
        type: "command",
        ...normalizedPayload,
      });
      const sendBytes = conn.sendBytes(binary);
      const handleError = (error: unknown) => {
        delete get().pendingCallbacks[timestamp];
        callback?.({
          command: payload.command,
          status: "error",
          error: String(error),
        });
      };
      if (sendJson && typeof sendJson.catch === "function") {
        sendJson.catch(handleError);
      }
      if (sendBytes && typeof sendBytes.catch === "function") {
        sendBytes.catch(handleError);
      }
    },
  }))
);

/** Loads the persisted transport after the platform storage has initialized. */
export const hydrateBackendTransportPreference = (): void => {
  const transportMode = getPreferredBackendTransportMode();
  useWebSocketStore.setState({
    transportMode,
    requiresAuthentication: transportRequiresAuthentication(transportMode),
  });
};
