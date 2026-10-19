import type { AuthPhase } from "@/shared/SecureWebSocket";
import type { BackendTransportMode } from "@/transport/types";
import type { TFunction } from "i18next";

export type BackendConnectionStatus = "connected" | "connecting" | "disconnected";

interface ConnectionSnapshot {
  transportMode: BackendTransportMode;
  _auth_phase: AuthPhase;
  _heartbeat_time: number;
  connections: Partial<Record<"provider" | "sync", { readonly readyState: number | undefined }>>;
}

/** The logo and About dialog describe the same authenticated backend connection. */
export function getBackendConnectionStatus(
  state: ConnectionSnapshot,
  staleHeartbeat: number | null = null
): BackendConnectionStatus {
  if (state._auth_phase === "idle" || state._auth_phase === "revoked") return "disconnected";
  if (state._auth_phase !== "authenticated") return "connecting";

  const connected =
    state.transportMode === "websocket"
      ? state._heartbeat_time > 0 && state._heartbeat_time !== staleHeartbeat
      : state.connections.provider?.readyState === 1 && state.connections.sync?.readyState === 1;
  return connected ? "connected" : "connecting";
}

export function formatBackendConnectionStatus(status: BackendConnectionStatus, t: TFunction) {
  if (status === "connected") return t("heartbeat.connected");
  if (status === "disconnected") return t("about.disconnected");
  return t("heartbeat.connecting");
}
