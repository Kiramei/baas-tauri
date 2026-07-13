import { useWebSocketStore } from "@/store/WebsocketStore.ts";

/** Starts platform services after React has mounted. */
export function startPlatformServices() {
  if (!__WITH_TAURI__) return;
  useWebSocketStore.getState().startTauriUpdaterPolling();
}
