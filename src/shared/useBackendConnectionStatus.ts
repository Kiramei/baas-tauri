import { create } from "zustand";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { getBackendConnectionStatus } from "@/shared/BackendConnectionStatus";

// Only the logo's watchdog writes this signal. About observes it without running recovery.
const useHeartbeatHealth = create<{ staleHeartbeat: number | null }>(() => ({
  staleHeartbeat: null,
}));

export function markBackendHeartbeatTimeout(staleHeartbeat: number | null) {
  if (useHeartbeatHealth.getState().staleHeartbeat !== staleHeartbeat)
    useHeartbeatHealth.setState({ staleHeartbeat });
}

export function useBackendConnectionStatus() {
  const staleHeartbeat = useHeartbeatHealth((state) => state.staleHeartbeat);
  return useWebSocketStore((state) => getBackendConnectionStatus(state, staleHeartbeat));
}
