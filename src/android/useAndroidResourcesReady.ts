import { useEffect, useRef, useState } from "react";
import { invoke } from "@/shared/TauriInvoke";
import { resolveAndroidInstallState, type AndroidStartupState } from "@/android/installState";

/** Require the current bootstrap's verified resources as well as provider readiness. */
export function useAndroidResourcesReady(backendInitialized: boolean, cycle = 0) {
  const [readyCycle, setReadyCycle] = useState<number | null>(null);
  const lastStartedAt = useRef<number | undefined>(undefined);
  const previousCycle = useRef(cycle);
  const rejectedStartedAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (previousCycle.current !== cycle) {
      rejectedStartedAt.current = lastStartedAt.current;
      previousCycle.current = cycle;
    }
    if (!__WITH_ANDROID__ || !__WITH_TAURI__ || !backendInitialized) {
      setReadyCycle(null);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const state = await invoke<AndroidStartupState>("updater_get_startup_state");
        if (disposed) return;
        const startedAt = state.bootstrap?.startedAt;
        if (
          resolveAndroidInstallState(state, null, null).resourcesReady &&
          typeof startedAt === "number" &&
          Number.isFinite(startedAt) &&
          startedAt !== rejectedStartedAt.current
        ) {
          lastStartedAt.current = startedAt;
          setReadyCycle(cycle);
          return;
        }
      } catch {
        // The setup screen owns the visible polling error and retry controls.
      }
      if (!disposed) timer = setTimeout(poll, 500);
    };
    setReadyCycle(null);
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [backendInitialized, cycle]);
  return !__WITH_ANDROID__ || !__WITH_TAURI__ || (backendInitialized && readyCycle === cycle);
}
