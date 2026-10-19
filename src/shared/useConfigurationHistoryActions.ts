import { useCallback, useSyncExternalStore } from "react";
import { configurationHistory } from "./useConfigurationDraft";

/** Toolbar/shortcut adapters share the same profile history as every configuration editor. */
export function useConfigurationHistoryActions(profileId: string | undefined) {
  const id = profileId ?? "";
  const subscribe = useCallback(
    (listener: () => void) => configurationHistory.subscribe(id, listener),
    [id]
  );
  const getSnapshot = useCallback(() => configurationHistory.getSnapshot(id), [id]);
  const { canUndo, canRedo } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const undo = useCallback(() => configurationHistory.undo(id), [id]);
  const redo = useCallback(() => configurationHistory.redo(id), [id]);
  const flush = useCallback(() => configurationHistory.flush(id), [id]);
  return { undo, redo, canUndo, canRedo, flush };
}
