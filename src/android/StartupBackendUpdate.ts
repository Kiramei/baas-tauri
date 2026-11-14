import { useEffect, useLayoutEffect, useRef } from "react";
import { create } from "zustand";
import { useUISetting } from "@/context/UISettingsProvider";
import { isTauriNoUpdateEnabled, useWebSocketStore } from "@/store/WebsocketStore";
import StorageUtil from "@/shared/StorageManager";
import { androidManualControl } from "@/shared/AndroidManualControl";
import { command } from "@/shared/BackendUpdateCommands";
import { updateAndroidBackend } from "@/shared/AndroidBackendUpdate";
import {
  AndroidStartupUpdateCoordinator,
  type AndroidStartupUpdateState,
  type StartupUpdateContext,
} from "@/shared/AndroidStartupUpdate";
import type { UpdateResumeState } from "@/shared/IdleUpdateState";

const RESUME_KEY = "idleBackendUpdateResume";
export const useAndroidStartupUpdateStore = create<AndroidStartupUpdateState>(() => ({
  phase: "waiting",
  error: null,
  cycle: 0,
  canContinueLocal: false,
}));
let currentCoordinator: AndroidStartupUpdateCoordinator | null = null;
let inputProvider: (() => StartupUpdateContext) | null = null;
const unavailable: StartupUpdateContext = {
  ready: false,
  enabled: false,
  key: null,
  session: null,
  root: "",
  ids: [],
  activity: "",
};

export async function retryAndroidStartupUpdate(options?: { backendRestarted?: boolean }) {
  const controller = currentCoordinator;
  if (!controller) return;
  const restart = controller.state.phase === "failed" && controller.state.cycle > 0;
  if (!controller.retry(restart) || !restart || options?.backendRestarted) return;
  try {
    const { invoke } = await import("@/shared/TauriInvoke");
    const result = await invoke<{ restartScheduled?: boolean }>("updater_restart_backend");
    if (result?.restartScheduled !== true)
      throw new Error("Android backend restart was not scheduled");
  } catch (error) {
    controller.restartFailed(error);
    throw error;
  }
}
export function continueAndroidStartupLocally() {
  currentCoordinator?.useLocal();
}

/** Mount in AppContext, before its children are allowed to render the home page. */
export function useAndroidStartupBackendUpdate(resourcesReady: boolean): boolean {
  const enabled = useUISetting((settings) => settings.idleAutoUpdate ?? true);
  const ready = useAndroidStartupUpdateStore((state) => state.phase === "ready");
  const resources = useRef(resourcesReady);
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    resources.current = resourcesReady;
    enabledRef.current = enabled;
    currentCoordinator?.observeResourcesReady(resourcesReady);
  }, [resourcesReady, enabled]);
  useEffect(() => {
    if (!__WITH_ANDROID__ || !__WITH_TAURI__) return;
    const ownInputs = () => {
      const state = useWebSocketStore.getState();
      return {
        ready:
          resources.current &&
          state._auth_phase === "authenticated" &&
          state._android_ui_ready &&
          state._all_data_initialized &&
          !state._initiating &&
          state.connections.trigger?.readyState === 1,
        enabled: enabledRef.current,
        key: state.connections.trigger,
        session: state._session,
        root: String(StorageUtil.get("base_dir") ?? ""),
        ids: Object.keys(state.configStore),
        activity: JSON.stringify(
          Object.entries(state.statusStore).map(([id, status]) => [
            id,
            status.running,
            status.current_task,
            status.waiting_tasks,
            status.run_mode,
            status.run_id,
          ])
        ),
      };
    };
    inputProvider = ownInputs;
    const controller =
      currentCoordinator ??
      new AndroidStartupUpdateCoordinator({
        context: () => inputProvider?.() ?? unavailable,
        noUpdate: isTauriNoUpdateEnabled,
        check: async () => {
          const { invoke } = await import("@/shared/TauriInvoke");
          const original = useWebSocketStore.getState();
          const report = await invoke<any>("updater_check_version", { request: {} });
          const latest = useWebSocketStore.getState();
          if (
            latest.connections.trigger === original.connections.trigger &&
            latest._session === original._session
          )
            useWebSocketStore.setState((state) => ({
              versionStore: {
                ...state.versionStore,
                ...report,
                checking: false,
                error: null,
                lastChecked: Date.now(),
              },
            }));
          return report;
        },
        command,
        loadResume: () => StorageUtil.get<UpdateResumeState>(RESUME_KEY),
        saveResume: (resume) => StorageUtil.setDurable(RESUME_KEY, resume),
        clearResume: () => StorageUtil.removeDurable(RESUME_KEY),
        update: updateAndroidBackend,
        beginUpdate: () => androidManualControl.beginBackendUpdate(),
        endUpdate: () => androidManualControl.endBackendUpdate(),
        manualActive: () => androidManualControl.isActive(),
        publish: (state) => useAndroidStartupUpdateStore.setState(state),
        now: Date.now,
      });
    currentCoordinator = controller;
    useAndroidStartupUpdateStore.setState(controller.state);
    const timer = setInterval(() => {
      void controller.tick();
    }, 500);
    void controller.tick();
    return () => {
      clearInterval(timer);
      if (inputProvider === ownInputs) inputProvider = null;
    };
  }, []);
  return !__WITH_ANDROID__ || !__WITH_TAURI__ || ready;
}
