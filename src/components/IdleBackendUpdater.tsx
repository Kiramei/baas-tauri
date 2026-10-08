import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useUISetting } from "@/context/UISettingsProvider";
import { isTauriNoUpdateEnabled, useWebSocketStore } from "@/store/WebsocketStore";
import StorageUtil from "@/shared/StorageManager";
import { getTimestampMs } from "@/shared/GlobalUtilities";
import { reloadWithoutPrompt } from "@/shared/reload";
import {
  allProfilesIdle,
  captureUpdateResumeState,
  performIdleUpdate,
  restoreUpdateResumeState,
  type IdleScriptStatus,
  type UpdateResumeState,
} from "@/shared/IdleUpdateState";

const RESUME_KEY = "idleBackendUpdateResume";
const ATTEMPT_KEY = "idleBackendUpdateAttempt";
const RETRY_DELAY_MS = 5 * 60_000;
let operationInProgress = false;
let reloadPending = false;
let commandTimestamp = 0;

async function command(name: string, configId?: string): Promise<any> {
  const store = useWebSocketStore.getState();
  if (!store.connections.trigger) throw new Error("Backend command channel is unavailable");
  const timestamp = Math.max(getTimestampMs(), commandTimestamp + 1);
  commandTimestamp = timestamp;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      delete useWebSocketStore.getState().pendingCallbacks[timestamp];
      reject(new Error(`Backend command timed out: ${name}`));
    }, 30_000);
    store.trigger({ timestamp, command: name, config_id: configId, payload: {} }, (response) => {
      clearTimeout(timer);
      if (response.status === "error") reject(new Error(String(response.error ?? name)));
      else resolve(response.data);
    });
  });
}

async function updateAndroidBackend() {
  const [{ listen }, { invoke }] = await Promise.all([
    import("@tauri-apps/api/event"),
    import("@/shared/TauriInvoke"),
  ]);
  let finish: (success: boolean) => void = () => {};
  const finished = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const unlisten = await listen<{ success: boolean }>("term:session-finished", (event) => {
    finish(event.payload.success);
  });
  const timer = setTimeout(() => finish(false), 30 * 60_000);
  try {
    await invoke("updater_start_workflow", { request: { launch: false } });
    if (!(await finished)) {
      await invoke("updater_abort_workflow", { request: { cleanup: false, emitEvents: false } });
      throw new Error("Android backend update failed");
    }
    await invoke("updater_reset_backend_auth_and_restart");
  } finally {
    clearTimeout(timer);
    unlisten();
  }
}

/** Coordinates backend updates and one-time restoration independently of the visible page. */
export default function IdleBackendUpdater({ clientUpdating }: { clientUpdating: boolean }) {
  const enabled = useUISetting((settings) => settings.idleAutoUpdate ?? true);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled && !clientUpdating;
  }, [enabled, clientUpdating]);
  const { t } = useTranslation();
  const idleSince = useRef<number | null>(null);
  const retryAfter = useRef(0);

  useEffect(() => {
    if (!__WITH_TAURI__ || __WITH_WEBUI__) return;
    async function tick() {
      if (operationInProgress || reloadPending || Date.now() < retryAfter.current) return;
      const state = useWebSocketStore.getState();
      if (
        state._auth_phase !== "authenticated" ||
        !state._all_data_initialized ||
        state._initiating ||
        !state.connections.trigger
      ) {
        idleSince.current = null;
        return;
      }
      const ids = Object.keys(state.configStore);
      if (!ids.length || !ids.every((id) => state._receivedSnapshots[`config:${id}`])) return;
      const root = String(StorageUtil.get("base_dir") ?? "");
      const saved = StorageUtil.get<UpdateResumeState>(RESUME_KEY);
      operationInProgress = true;
      try {
        // Finish an interrupted update's restoration even when the switch is now off.
        if (saved) {
          if (
            saved.schema !== 1 ||
            saved.root !== root ||
            !saved.running ||
            Object.values(saved.running).some((running) => typeof running !== "boolean")
          ) {
            await StorageUtil.removeDurable(RESUME_KEY);
            return;
          }
          await restoreUpdateResumeState(saved, ids, command);
          await StorageUtil.removeDurable(RESUME_KEY);
          idleSince.current = null;
          return;
        }
        if (
          !enabledRef.current ||
          !state.versionStore.remote ||
          state.versionStore.local === state.versionStore.remote ||
          state.versionStore.checking
        ) {
          idleSince.current = null;
          return;
        }
        const attempt = StorageUtil.get<{ version: string; time: number }>(ATTEMPT_KEY);
        const version = String(state.versionStore.remote);
        if (attempt?.version === version && Date.now() - attempt.time < RETRY_DELAY_MS) return;
        if (await isTauriNoUpdateEnabled()) return;
        const rawStatuses = (await command("status")) as Record<string, IdleScriptStatus>;
        // The complete backend snapshot omits sessions that have never been started.
        const statuses = Object.fromEntries(
          ids.map((id) => [
            id,
            rawStatuses[id] ?? {
              running: false,
              current_task: null,
              waiting_tasks: [],
            },
          ])
        );
        const latest = useWebSocketStore.getState();
        const latestIds = Object.keys(latest.configStore);
        if (
          !enabledRef.current ||
          latestIds.length !== ids.length ||
          latestIds.some((id) => !ids.includes(id)) ||
          !allProfilesIdle(latestIds, statuses)
        ) {
          idleSince.current = null;
          return;
        }
        // Scheduler startup initially publishes empty queues; require a stable idle window.
        if (idleSince.current === null) idleSince.current = Date.now();
        if (Date.now() - idleSince.current < 3_000) return;
        const snapshot = captureUpdateResumeState(root, ids, statuses);
        // Flush to disk before stopping scripts or entering the updater.
        await StorageUtil.setDurable(ATTEMPT_KEY, { version, time: Date.now() });
        await performIdleUpdate({
          save: () => StorageUtil.setDurable(RESUME_KEY, snapshot),
          stop: () => command("stop_all_tasks"),
          update: async () => {
            if (__WITH_ANDROID__) await updateAndroidBackend();
            reloadPending = true;
            reloadWithoutPrompt();
          },
          restore: () => restoreUpdateResumeState(snapshot, ids, command),
          clear: () => StorageUtil.removeDurable(RESUME_KEY),
        });
      } catch (error) {
        reloadPending = false;
        retryAfter.current = Date.now() + RETRY_DELAY_MS;
        toast.error(t("update.backendStartFailed"), {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        operationInProgress = false;
      }
    }
    const timer = setInterval(() => {
      void tick();
    }, 1_000);
    void tick();
    return () => clearInterval(timer);
  }, [t]);
  return null;
}
