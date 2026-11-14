import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useUISetting } from "@/context/UISettingsProvider";
import { isTauriNoUpdateEnabled, useWebSocketStore } from "@/store/WebsocketStore";
import StorageUtil from "@/shared/StorageManager";
import { reloadWithoutPrompt } from "@/shared/reload";
import { command } from "@/shared/BackendUpdateCommands";
export { command } from "@/shared/BackendUpdateCommands";
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
    if (!__WITH_TAURI__ || __WITH_WEBUI__ || __WITH_ANDROID__) return;
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
