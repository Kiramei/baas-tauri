import { useEffect, useState } from "react";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { pluginRequest } from "./Plugins";
import {
  DEFAULT_PLUGIN_HOME_DATA,
  loadPluginHomeData,
  type PluginHomeData,
} from "./PluginHomeLayout";
import type { BackendConnection } from "@/transport/types";

type Snapshot = {
  configId: string;
  sessionId: string;
  connection: BackendConnection;
  data: PluginHomeData;
};

/** One authenticated read supplies both declarative home cards and profile layout. */
export function usePluginHomeLayout(configId?: string, active = true): PluginHomeData {
  const authenticated = useWebSocketStore((state) => state._auth_phase === "authenticated");
  const connection = useWebSocketStore((state) => state.connections.trigger);
  const ready = useWebSocketStore((state) => state.connections.trigger?.readyState === 1);
  const sessionId = useWebSocketStore((state) => state._session?.sessionId);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!active || !configId || !authenticated || !sessionId || !ready || !connection) return;
    let disposed = false;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      const isCurrent = () => {
        const state = useWebSocketStore.getState();
        return (
          !disposed &&
          current === generation &&
          state._auth_phase === "authenticated" &&
          state._session?.sessionId === sessionId &&
          state.connections.trigger === connection &&
          connection.readyState === 1
        );
      };
      void loadPluginHomeData(pluginRequest, configId, isCurrent)
        .then((data) => {
          if (data && isCurrent()) setSnapshot({ configId, sessionId, connection, data });
        })
        .catch(() => {
          if (isCurrent())
            setSnapshot({ configId, sessionId, connection, data: DEFAULT_PLUGIN_HOME_DATA });
        });
    };
    const changed = (event: Event) => {
      const changedConfig = (event as CustomEvent<{ configId?: string }>).detail?.configId;
      if (!changedConfig || changedConfig === configId) refresh();
    };
    refresh();
    window.addEventListener("baas:plugins-changed", changed);
    return () => {
      disposed = true;
      window.removeEventListener("baas:plugins-changed", changed);
    };
  }, [configId, active, authenticated, sessionId, ready, connection]);

  return authenticated &&
    ready &&
    snapshot &&
    snapshot.configId === configId &&
    snapshot.sessionId === sessionId &&
    snapshot.connection === connection
    ? snapshot.data
    : DEFAULT_PLUGIN_HOME_DATA;
}
