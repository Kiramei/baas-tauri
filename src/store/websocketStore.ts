import {toast} from "sonner"
import {create} from "zustand";
import {SecureWebSocket} from "@/lib/SecureWebSocket";
import {subscribeWithSelector} from "zustand/middleware";
import {getTimestampMs, isPlainObject} from "@/lib/utils.ts";
import {useGlobalLogStore} from "@/store/globalLogStore.ts";
import {t} from "i18next";
import {StorageUtil} from "@/lib/storage";
import {
  ConnectionError,
  LogItem,
  RawLogItem,
  StatusItem,
  WebSocketState,
  WrappedStatusItem,
  WsCallBackDict,
  WsMessageItem,
  WsName
} from "@/types/app";

const BASE = "ws://localhost:8190";


const {appendGlobalLog} = useGlobalLogStore.getState()

const connectWithRetry = async (name: WsName, retryInterval = 1000) => {
  const {connect} = useWebSocketStore.getState();

  while (true) {
    try {
      await connect(name);
      console.log(`[${name}] connected successfully`);
      return;
    } catch (err) {
      if ((err as ConnectionError).reason === "Invalid handshake response") {
        console.error(`[${name}] connect failed, maybe Secret is Incorrect!`, err);
        useWebSocketStore.setState(state => ({...state, _secret: ""}))
        StorageUtil.set("SECRET", "")
      } else {
        console.error(`[${name}] connect failed, retrying in ${retryInterval}ms`, err);
      }
      await new Promise((resolve) => setTimeout(resolve, retryInterval));
    }
  }
}


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

    const unsub = subscribe(
      selector,
      (val: T) => {
        if (predicate(val)) {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      }
    );

    let timer: any = null;
    if (timeoutMs !== Infinity) {
      timer = setTimeout(() => {
        unsub();
        reject(new Error("waitFor timeout"));
      }, timeoutMs);
    }
  });
}


export const waitForNormal = <T>(
  getter: () => T,
  predicate: (val: T) => boolean,
  timeoutMs = Infinity,
  intervalMs = 50
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const check = () => {
      try {
        const val = getter();
        if (predicate(val)) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - start >= timeoutMs) {
          clearInterval(timer);
          reject(new Error("waitFor timeout"));
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    };
    // Trigger an immediate evaluation so the caller does not wait for the first interval tick.
    check();
    const timer = setInterval(check, intervalMs);
  });
};
void waitForNormal;


export const useWebSocketStore = create<WebSocketState>()(
  subscribeWithSelector((set, get, api) => ({
    connections: {},
    logStore: {},
    configStore: {},
    staticStore: {},
    eventStore: {},
    updateStore: {},
    statusStore: {},
    versionStore: {},
    pendingCallbacks: {},

    _all_data_initialized: false,
    _heartbeat_time: 0,
    _initiating: false,
    _secret: "",

    connect: async (name: WsName) => {
      if (get().connections[name]) return;

      let url = "";
      if (name === "provider") url = `${BASE}/ws/provider`;
      if (name === "sync") url = `${BASE}/ws/sync`;
      if (name === "trigger") url = `${BASE}/ws/trigger`;
      if (name === "heartbeat") url = `${BASE}/ws/heartbeat`;

      const resourceCallBack: WsCallBackDict = {
        "config": (message: WsMessageItem) => {
          set((state) => ({
            configStore: {
              ...state.configStore,
              [message.resource_id!]: message.data,
            },
          }));
        },
        "event": (message: WsMessageItem) => {
          set((state) => ({
            eventStore: {
              ...state.eventStore,
              [message.resource_id!]: message.data,
            },
          }));
        },
        "static": (message: WsMessageItem) => {
          set((_) => ({
            staticStore: message.data,
          }));
        },
        "setup_toml": (message: WsMessageItem) => {
          set((_) => ({
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

            const log_added = Object.fromEntries(
              message.data
                .map((id: string) => {
                  const key = `config:${id}`;
                  if (key in state.logStore) return null;
                  return [key, []];
                })
                .filter((x: any): x is [string, LogItem[]] => Boolean(x))
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
              Object.entries(state.logStore).filter(([key]) =>
                message.data.some((id: string) => key === `config:${id}`)
              )
            );

            const status_kept = Object.fromEntries(
              Object.entries(state.statusStore).filter(([id]) => message.data.includes(id))
            );

            return {
              configStore: {...config_kept, ...config_added},
              eventStore: {...event_kept, ...event_added},
              logStore: {...log_kept, ...log_added},
              statusStore: {...status_kept, ...status_added},
            };
          });
        },

        "snapshot": (message: WsMessageItem) => {
          resourceCallBack[message.resource!](message);
        },

        "logs_full": (message: WsMessageItem) => {
          const scopes = message.scopes;
          const log_added: { [key: string]: LogItem[] } = Object.fromEntries(scopes!.map((id) => [id, []]));
          const entries = message.entries;
          entries!.forEach((e: RawLogItem) => {
            const info = {
              time: e.time,
              level: e.level,
              message: e.message
            }
            log_added[e.scope].push(info)
            if (e.scope == 'global') appendGlobalLog(info)
          })
          set(_ => {
            return {logStore: log_added}
          })
        },
        "log": (message: WsMessageItem) => {
          const data = message.entry;
          const info = {
            time: data!.time,
            level: data!.level,
            message: data!.message,
          };

          set((state) => {
            const prevLogs = state.logStore[data!.scope] ?? [];
            return {
              logStore: {
                ...state.logStore,
                [data!.scope]: [...prevLogs, info], // Preserve existing log history while appending the new item.
              },
            };
          });
          if (data!.scope == 'global') appendGlobalLog(info)
        },
        "status": (message: WsMessageItem) => {
          const data = message.status;
          if (typeof data === "string") return
          if ("is_all_data_initialized" in data!) {
            set(state => ({...state, _all_data_initialized: true}));
          } else {
            let k0 = Object.keys(data!)[0];
            if (typeof data![k0] === "object" && "config_id" in data![k0]) {
              Object.keys(data!).forEach((key) => {
                set(state => ({
                  statusStore: {
                    ...state.statusStore,
                    [key]: {
                      ...(state.statusStore[key] ?? {}),
                      ...(data![key] as StatusItem)
                    }
                  }
                }));
              });
            } else {
              set(state => ({
                statusStore: {
                  ...state.statusStore,
                  [(data as StatusItem).config_id!]: (data as WrappedStatusItem).status
                }
              }));
            }
          }
        },
        "command_response": (message: WsMessageItem) => {
          const {timestamp, command, data, status} = message;

          const cb = get().pendingCallbacks[timestamp!];
          if (cb) {
            cb({command, data, status});
            delete get().pendingCallbacks[timestamp!];
          } else {
            console.warn("CallBack Not Found:", message);
          }
        },

        "patch": (message: WsMessageItem) => {
          const ops = message.ops;
          const resource = message.resource;
          if (resource === "gui") return;
          const resource_id = message.resource_id ?? null;
          if (!resource_id) return;

          if (Array.isArray(ops)) {
            ops.forEach((op) => {
              if (op.op === "add") {
                get().send("sync", {type: "list"});
                const prev_len = Object.keys(get().configStore).length
                waitFor(
                  get,
                  api.subscribe,
                  (s: WebSocketState) => Object.keys(s.configStore).length,
                  (len) => len === prev_len + 1
                ).then(() => {
                  get().send("sync", {type: "pull", resource: "config", resource_id: resource_id});
                  get().send("sync", {type: "pull", resource: "event", resource_id: resource_id});
                })
              }
              if (op.op === "remove") {
                get().send("sync", {type: "list"});
              } else {
                const path = `${resource_id}::${resource}${op.path}`;
                let value = op.value;
                get().patch(path, value);
              }
            });
          } else {
            console.error("Invalid patch message:", message);
          }
        },

        "patch_ack": (message: WsMessageItem) => {
          const {timestamp} = message;
          const cb = get().pendingCallbacks[timestamp!];
          if (cb) {
            cb();
            delete get().pendingCallbacks[timestamp!];
          } else {
            console.warn("CallBack Not Found:", message);
          }
        },

        "heartbeat": (message: WsMessageItem) => {
          const {timestamp} = message;
          set(state => ({...state, _heartbeat_time: timestamp}));
        }
      };

      set(state => ({...state, _secret: StorageUtil.get("SECRET")}))

      await waitFor(
        get,
        api.subscribe,
        (s: WebSocketState) => s._secret,
        (s: string) => s !== ""
      )

      StorageUtil.set("SECRET", get()._secret);

      const ws = new SecureWebSocket(url, get()._secret, name);
      await ws.connect((msg) => {
        try {
          const message = JSON.parse(msg) as WsMessageItem;
          callbackDict[message.type]?.(message);
        } catch (err) {
          console.error("Message parse error:", err, msg);
        }
      });

      ws.onClose = () => {
        set((state) => {
          const next = {...state.connections};
          delete next[name];
          return {connections: next};
        });
      };

      ws.onError = (e) => console.error("Socket error:", e);

      set((state) => ({
        connections: {...state.connections, [name]: ws},
      }));
    },


    disconnect: (name: WsName) => {
      const conn = get().connections[name];
      if (conn) {
        (conn as any).ws?.close();
        set((state) => {
          const next = {...state.connections};
          delete next[name];
          return {connections: next};
        });
      }
    },

    send: (name: WsName, data: any) => {
      const conn = get().connections[name];
      if (conn) conn.sendJson(data);
    },

    init: async () => {
      if (get()._initiating) return;
      set(state => ({...state, _initiating: true}));
      await connectWithRetry("heartbeat");

      await connectWithRetry("provider")
      // Uncomment during deep diagnostics to halt before sync initialization.
      // await pause(Infinity)
      // Establish the sync channel once the provider handshake succeeds.
      await connectWithRetry("sync")

      get().send("sync", {type: "pull", resource: "static"});
      await waitFor(
        get,
        api.subscribe,
        (s: WebSocketState) => Object.keys(s.staticStore).length,
        (len) => len > 0
      );

      get().send("sync", {type: "pull", resource: "setup_toml", resource_id: "global"});
      await waitFor(
        get,
        api.subscribe,
        (s: WebSocketState) => Object.keys(s.updateStore).length,
        (len) => len > 0
      );

      get().send("sync", {type: "list"});

      await waitFor(
        get,
        api.subscribe,
        (s: WebSocketState) => Object.keys(s.configStore).length,
        (len) => len > 0
      );

      Object.keys(get().configStore).forEach((key: string) => {
        get().send("sync", {type: "pull", resource: "config", resource_id: key});
      });

      await waitFor(
        get,
        api.subscribe,
        (s: WebSocketState) => Object.keys(s.eventStore).length,
        (len) => len > 0
      );

      Object.keys(get().configStore).forEach((key: string) => {
        get().send("sync", {type: "pull", resource: "event", resource_id: key});
      });

      await connectWithRetry("trigger");

      get().trigger({
        timestamp: getTimestampMs(),
        command: "check_for_update",
        payload: {}
      }, (e) => {
        set((state) => ({
          ...state, versionStore: {
            local: e.data.local,
            remote: e.data.remote
          }
        }))
      });

      await waitFor(
        get,
        api.subscribe,
        (s: WebSocketState) => s.versionStore,
        (versionStore) => Object.keys(versionStore).length > 0
      );

      await waitFor(
        get,
        api.subscribe,
        (s: WebSocketState) => s._all_data_initialized,
        (status) => status
      );

      set(state => ({...state, _initiating: false}));
    },

    patch: (path: string, patch: any) => {
      const [resourceId, scopeRaw] = path.split("::");
      const [scope, ...keys] = scopeRaw.split("/");

      // @ts-ignore
      set((state: WebSocketState) => {
        let storeKey: keyof WebSocketState;
        // Determine which store should receive the patch.
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
          return; // No mutation required when the existing value is already in sync.
        }

        let base = {...prev};
        // Apply the patch directly when targeting the root resource.
        if (keys.length === 0 || (keys.length === 1 && keys[0] === "")) base = patch;
        else {
          // Walk the nested path so only the targeted leaf is replaced.
          let current = base;
          for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (!current[key]) {
              current[key] = {};
            }
            current = current[key];
          }

          const lastKey = keys[keys.length - 1];
          current[lastKey] = patch;
        }
        if (resourceId === "global")
          return {
            [storeKey]: {
              ...store,
              ...base
            }
          };
        else
          return {
            [storeKey]: {
              ...store,
              [resourceId]: base
            }
          };
      });
    },


    modify: (path: string, patch: any, showToast: boolean = false) => {
      const [resourceId, scope] = path.split("::");
      const timestamp = getTimestampMs();
      const ops = isPlainObject(patch) ?
        Object.entries(patch).map(([key, value]) => ({
          op: "replace",
          path: `/${key}`,
          value: value
        }))
        :
        [{
          op: "replace",
          path: "/",
          value: patch
        }]
      get().pendingCallbacks[timestamp] = () => {
        if (showToast) {
          toast.success(t("settings.updateSuccess"), {
            description: t("settings.updateSuccessDesc"),
          })
        }
      };
      get().send("sync", {
        type: "patch",
        resource_id: resourceId,
        resource: scope,
        timestamp: timestamp,
        ops: ops
      });
    },

    trigger: (payload, callback) => {
      const _timestamp = payload.timestamp || Date.now();
      if (callback) {
        get().pendingCallbacks[_timestamp] = callback;
      }
      get().send("trigger", {
        type: "command",
        _timestamp,
        ...payload,
      });
    }
  }))
);
