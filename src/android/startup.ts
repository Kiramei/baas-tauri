/** Starts Android-only services after React has mounted. */
export function startPlatformServices() {
  if (!__WITH_TAURI__) return;
  setTimeout(() => {
    void import("@/store/BackendStore").then(({ useBackendStore }) => {
      useBackendStore.getState().startTauriUpdaterPolling();
    });
  }, 5_000);
}
