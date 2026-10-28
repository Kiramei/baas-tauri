import {
  useCallback,
  useEffect,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useWebSocketStore } from "@/store/WebsocketStore";
import {
  ConfigurationHistory,
  serializeConfigurationDraft,
  type ConfigurationSerializer,
} from "./ConfigurationHistory";
import type { ConfigurationSection } from "./ConfigurationSections";

export const configurationHistory = new ConfigurationHistory({
  persist: (profileId, patch) => useWebSocketStore.getState().modify(`${profileId}::config`, patch),
});

/** Local drafts and undo snapshots are window state; only serialized edits reach the script. */
export function useConfigurationDraft<T>(
  profileId: string | undefined,
  section: ConfigurationSection,
  initial: T,
  options?: { serialize?: ConfigurationSerializer<T> }
): readonly [T, Dispatch<SetStateAction<T>>, () => void] {
  const id = profileId ?? "";
  const serialize = options?.serialize ?? serializeConfigurationDraft<T>;
  configurationHistory.ensure(id, section, initial, serialize);

  const subscribe = useCallback(
    (listener: () => void) => configurationHistory.subscribe(id, listener),
    [id]
  );
  const getDraft = useCallback(
    () => configurationHistory.getDraft(id, section, initial),
    [id, section, initial]
  );
  const draft = useSyncExternalStore(subscribe, getDraft, getDraft);
  const setDraft: Dispatch<SetStateAction<T>> = useCallback(
    (value: SetStateAction<T>) => configurationHistory.update(id, section, value),
    [id, section]
  );
  const flush = useCallback(() => configurationHistory.flush(id, section), [id, section]);

  useEffect(() => {
    configurationHistory.syncSource(id, section, initial);
  }, [id, section, initial]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      // React Activity cleanup also runs on navigation to another cached editor.
      flush();
    };
  }, [flush]);
  return [draft, setDraft, flush] as const;
}
