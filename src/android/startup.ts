/** Starts Android-only services after React has mounted. */
export function startPlatformServices() {
  if (!__WITH_TAURI__) return;
  void import("@/store/WebsocketStore.ts").then(({ useWebSocketStore }) => {
    useWebSocketStore.getState().startTauriUpdaterPolling();
  });
}
