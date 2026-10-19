import { useSyncExternalStore } from "react";
import { settingsSearchStore } from "./SettingsSearch";

export function useSettingsSearch() {
  return useSyncExternalStore(
    settingsSearchStore.subscribe,
    settingsSearchStore.getSnapshot,
    settingsSearchStore.getSnapshot
  );
}
