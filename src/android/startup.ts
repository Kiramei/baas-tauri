/** Starts Android-only services after React has mounted. */
export function startPlatformServices() {
  if (!__WITH_TAURI__) return;
  setTimeout(() => {
    void import("@/store/WebsocketStore.ts").then(({ useWebSocketStore }) => {
      useWebSocketStore.getState().startTauriUpdaterPolling();
    });
  }, 5_000);
}
