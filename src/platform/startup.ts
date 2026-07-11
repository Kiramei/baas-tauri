import { useBackendStore } from "@/store/BackendStore";

/** Starts platform services after React has mounted. */
export function startPlatformServices() {
  if (!__WITH_TAURI__) return;
  useBackendStore.getState().startTauriUpdaterPolling();
}
