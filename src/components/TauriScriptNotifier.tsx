import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

import { useUISettings } from "@/context/UISettingsProvider";
import { eventNameKey } from "@/shared/I18nKeys";
import { useWebSocketStore } from "@/store/WebsocketStore";

type ScriptStatus = {
  running?: boolean;
  config_id?: string | null;
  current_task?: string | null;
  waiting_tasks?: string[];
  exit_code?: number | string | null;
};

type StatusSnapshot = {
  running: boolean;
  currentTask: string | null;
  lastTask: string | null;
  exitCode: number | string | null;
};

/** Treats any non-zero numeric exit code or opaque non-empty exit marker as a failure. */
const isFailureExitCode = (exitCode: number | string | null | undefined) => {
  if (exitCode === null || exitCode === undefined || exitCode === "") return false;
  const numeric = Number(exitCode);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
};

/** Emits native system notifications for Tauri-only script lifecycle events. */
const TauriScriptNotifier: React.FC = () => {
  const { t } = useTranslation();
  const { uiSettings } = useUISettings();
  const notificationsEnabled = uiSettings.enableSystemNotifications;
  const statusStore = useWebSocketStore((state) => state.statusStore);
  const previousRef = useRef<Record<string, StatusSnapshot>>({});
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!__WITH_TAURI__) return;

    const nextSnapshots: Record<string, StatusSnapshot> = {};
    const notify = notificationsEnabled
      ? (title: string, body: string, tag: string) => {
          void invoke("baas_notify", {
            payload: { title, body, tag },
          }).catch((error) => {
            console.warn("[notifier] failed to send system notification", error);
          });
        }
      : () => {};

    for (const [configId, status] of Object.entries(statusStore as Record<string, ScriptStatus>)) {
      const previous = previousRef.current[configId];
      const currentTask = status.current_task ?? null;
      const next: StatusSnapshot = {
        running: Boolean(status.running),
        currentTask,
        lastTask: currentTask ?? previous?.lastTask ?? null,
        exitCode: status.exit_code ?? null,
      };
      nextSnapshots[configId] = next;

      if (!initializedRef.current || !previous) {
        continue;
      }

      const completedTask =
        previous.currentTask && previous.currentTask !== currentTask ? previous.currentTask : null;
      const failed = previous.running && !next.running && isFailureExitCode(next.exitCode);
      const stoppedTask = previous.currentTask ?? previous.lastTask;

      if (failed && stoppedTask) {
        const task = t(eventNameKey(stoppedTask));
        notify(
          t("notification.script.failedTitle"),
          t("notification.script.failedBody", { task, exitCode: next.exitCode }),
          `script:${configId}:failed:${stoppedTask}:${next.exitCode}`,
        );
      } else if (completedTask) {
        const task = t(eventNameKey(completedTask));
        notify(
          t("notification.script.completedTitle"),
          t("notification.script.completedBody", { task }),
          `script:${configId}:completed:${completedTask}`,
        );
      }

      if (currentTask && currentTask !== previous.currentTask) {
        const task = t(eventNameKey(currentTask));
        notify(
          t("notification.script.startedTitle"),
          t("notification.script.startedBody", { task }),
          `script:${configId}:started:${currentTask}`,
        );
      }
    }

    previousRef.current = nextSnapshots;
    initializedRef.current = true;
  }, [notificationsEnabled, statusStore, t]);

  return null;
};

export default TauriScriptNotifier;
